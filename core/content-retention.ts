import type { RecoveryRecord } from "./recovery-record";
import { normalizeRepositoryStateReference } from "./local-state-layout";

export interface StagingReachability {
  dirtyRecords: readonly string[];
  localConcurrentRecords: readonly string[];
  outbox: readonly string[];
  publishedReconciles: readonly string[];
  conflictDrafts: readonly string[];
  journals: readonly string[];
  recoveryRecords: readonly RecoveryRecord[];
}

export interface StagingCleanupPlan {
  retained: string[];
  removable: string[];
}

export function planStagingCleanup(candidates: readonly string[], reachability: StagingReachability): StagingCleanupPlan {
  const reachable = new Set([
    ...reachability.dirtyRecords,
    ...reachability.localConcurrentRecords,
    ...reachability.outbox,
    ...reachability.publishedReconciles,
    ...reachability.conflictDrafts,
    ...reachability.journals,
  ]);
  // v1 恢复文件不参与自动清理，即使记录已解除其他引用也仍保留。
  for (const recovery of reachability.recoveryRecords) reachable.add(recovery.contentRef);
  const unique = [...new Set(candidates)].sort();
  return {
    retained: unique.filter((ref) => reachable.has(ref)),
    removable: unique.filter((ref) => !reachable.has(ref)),
  };
}

export function collectStagingReachabilityFromRepositoryState(state: unknown): StagingReachability {
  if (!isRecord(state)) throw new Error("repository state reachability payload is invalid");
  const dirtyRecords = collectConfirmedValueRefs(recordValues(state.dirtyIntents));
  const localConcurrentValues = recordValues(state.localConcurrentRecords);
  const localConcurrentRecords = collectConfirmedValueRefs(localConcurrentValues.flatMap((record) => isRecord(record)
    ? [record.editorValue, record.externalValue, isRecord(record.selection) ? record.selection.value : undefined]
      .filter((value) => value !== undefined)
    : []));
  for (const record of localConcurrentValues) {
    if (!isRecord(record) || !isRecord(record.selection) || !Array.isArray(record.selection.unselectedContentRefs)) continue;
    for (const reference of record.selection.unselectedContentRefs) if (typeof reference === "string") localConcurrentRecords.push(assertReference(reference));
  }

  const outbox: string[] = [];
  for (const entry of arrayValues(state.durableOutbox)) {
    if (!isRecord(entry)) continue;
    for (const object of arrayValues(entry.objects)) if (isRecord(object) && typeof object.contentRef === "string") outbox.push(assertReference(object.contentRef));
    for (const mutation of arrayValues(entry.mutations)) if (isRecord(mutation) && typeof mutation.stagedContentRef === "string") outbox.push(assertReference(mutation.stagedContentRef));
  }
  const publishedReconciles = arrayValues(state.publishedReconciles)
    .flatMap((record) => isRecord(record) && typeof record.stagedContentRef === "string" ? [assertReference(record.stagedContentRef)] : []);
  const conflictDrafts = recordValues(state.conflictDrafts)
    .flatMap((record) => isRecord(record) ? referencesFromKeys(record, ["contentRef", "stagedRef"]) : []);
  const journals = arrayValues(state.applyJournals)
    .flatMap((record) => isRecord(record) ? [
      ...referencesFromKeys(record, ["recoveryRef"]),
      ...(isRecord(record.target) ? referencesFromKeys(record.target, ["stagedRef"]) : []),
      ...(isRecord(record.recoveryRecord) ? referencesFromKeys(record.recoveryRecord, ["contentRef"]) : []),
    ] : []);
  const recoveryRecords = recordValues(state.recoveryRecords)
    .map(toRecoveryRecord)
    .filter((record): record is RecoveryRecord => record !== undefined);
  return {
    dirtyRecords: unique(dirtyRecords),
    localConcurrentRecords: unique(localConcurrentRecords),
    outbox: unique(outbox),
    publishedReconciles: unique(publishedReconciles),
    conflictDrafts: unique(conflictDrafts),
    journals: unique(journals),
    recoveryRecords: recoveryRecords.map((record) => ({ ...record, contentRef: assertReference(record.contentRef) })),
  };
}

export function planRepositoryStagingCleanup(candidates: readonly string[], state: unknown): StagingCleanupPlan {
  return planStagingCleanup(candidates.map(assertReference), collectStagingReachabilityFromRepositoryState(state));
}

export function assertStagingReferenceBelowStateRoot(stateRoot: string, contentRef: string): void {
  const normalizedRoot = normalizeRelative(stateRoot);
  const normalizedRef = normalizeRelative(contentRef);
  if (normalizedRef !== normalizedRoot && !normalizedRef.startsWith(`${normalizedRoot}/`)) {
    throw new Error("staging reference escapes repository state root");
  }
}

function normalizeRelative(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (normalized.length === 0 || normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("state path is invalid");
  }
  return normalized;
}

function collectConfirmedValueRefs(values: readonly unknown[]): string[] {
  return values.flatMap((value) => isRecord(value) && value.kind === "put" && typeof value.stagedPath === "string"
    ? [assertReference(value.stagedPath)]
    : isRecord(value) && isRecord(value.value) && value.value.kind === "put" && typeof value.value.stagedPath === "string"
      ? [assertReference(value.value.stagedPath)]
      : []);
}

function referencesFromKeys(value: Record<string, unknown>, keys: readonly string[]): string[] {
  return keys.flatMap((key) => typeof value[key] === "string" ? [assertReference(value[key] as string)] : []);
}

function assertReference(reference: string): string {
  return normalizeRepositoryStateReference(reference);
}

function recordValues(value: unknown): unknown[] {
  return isRecord(value) ? Object.values(value) : [];
}

function arrayValues(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function toRecoveryRecord(value: unknown): RecoveryRecord | undefined {
  if (!(isRecord(value) && typeof value.id === "string" && typeof value.contentRef === "string"
    && typeof value.logicalPath === "string" && typeof value.source === "string"
    && typeof value.capturedHash === "string" && typeof value.capturedSize === "number"
    && typeof value.lastStableHash === "string" && typeof value.lastStableSize === "number"
    && typeof value.capturedAt === "number" && typeof value.postCaptureEdit === "boolean"
    && typeof value.cleanupState === "string")) return undefined;
  return { ...value } as unknown as RecoveryRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
