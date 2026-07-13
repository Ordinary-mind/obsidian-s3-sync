import type { DurableStateSnapshot, DurableStateStore, StateJsonValue } from "./durable-state";
import {
  assertDurableOutboxQueue,
  createPublishedReconciles,
  nextDurableOutbox,
  transitionDurableOutbox,
  type DurableOutboxEntry,
} from "./durable-outbox";
import { parseRepositoryDurablePayload } from "./repository-durable-payload";
import { isMaximumSequence, nextSequence } from "./sequence";

export interface DurableOutboxReference {
  id: string;
  writerId: string;
  sequence: string;
  commitHash: string;
  stagedPath: string;
  captureGeneration: number;
}

export async function writeRepositoryStateTransaction(
  store: DurableStateStore<StateJsonValue>,
  next: StateJsonValue,
): Promise<DurableStateSnapshot<StateJsonValue>> {
  return store.update((current) => {
    if (!isRecord(next)) throw new Error("repository transaction payload must be an object");
    const merged: Record<string, StateJsonValue> = { ...(isRecord(current) ? current : {}), ...next };
    const nextIdentity = validateRepositoryStatePayload(merged);
    if (current) {
      const currentIdentity = validateRepositoryStatePayload(current);
      if (currentIdentity.repositoryFingerprint !== nextIdentity.repositoryFingerprint) throw new Error("repository transaction fingerprint changed");
      if (currentIdentity.writerId === nextIdentity.writerId && BigInt(nextIdentity.nextSequence) < BigInt(currentIdentity.nextSequence)) {
        throw new Error("repository transaction writer sequence regressed");
      }
    }
    return merged;
  });
}

export async function freezeDurableOutboxStateTransaction(
  store: DurableStateStore<StateJsonValue>,
  entry: DurableOutboxEntry,
  causalPatch: Partial<Record<"dirtyIntents" | "projections" | "localConcurrentRecords", StateJsonValue>> = {},
): Promise<DurableStateSnapshot<StateJsonValue>> {
  return store.update((current) => {
    if (!isRecord(current)) throw new Error("repository state must exist before freezing Outbox");
    const identity = validateRepositoryStatePayload(current);
    if (entry.writerId !== identity.writerId || entry.sequence !== identity.nextSequence
      || entry.previousCommitHash !== identity.previousCommitHash) {
      throw new Error("Outbox reservation does not match the durable writer cursor");
    }
    const entries = parseDurableOutboxEntries(current.durableOutbox);
    if (entries.some((existing) => existing.id === entry.id)) throw new Error("Outbox Commit is already frozen");
    if (isMaximumSequence(entry.sequence) && entries.some((existing) => existing.writerId === entry.writerId && existing.sequence === entry.sequence)) {
      throw new Error("maximum writer sequence is already allocated");
    }
    const nextEntries = [...entries, entry];
    assertDurableOutboxQueue(nextEntries);
    const merged: Record<string, StateJsonValue> = {
      ...current,
      ...causalPatch,
      durableOutbox: toJson(nextEntries),
      outboxRefs: toJson(nextEntries.map(outboxReference)),
      previousCommitHash: entry.commitHash,
      nextSequence: isMaximumSequence(entry.sequence) ? entry.sequence : nextSequence(entry.sequence),
      writerRotationPending: isMaximumSequence(entry.sequence),
    };
    validateRepositoryStatePayload(merged);
    return merged;
  });
}

export async function beginDurableOutboxPublicationTransaction(
  store: DurableStateStore<StateJsonValue>,
  outboxId: string,
): Promise<DurableStateSnapshot<StateJsonValue>> {
  return updateDurableOutbox(store, (entries, identity) => {
    const next = nextDurableOutbox(entries, identity.writerId);
    if (!next || next.id !== outboxId) throw new Error("Outbox is not the next FIFO entry");
    if (next.state === "publishing") return entries;
    return replaceOutbox(entries, transitionDurableOutbox(next, "publishing"));
  });
}

export async function confirmDurableOutboxPublishedTransaction(
  store: DurableStateStore<StateJsonValue>,
  outboxId: string,
  verifiedCommitHash: string,
  verifiedStatePatch: Partial<Record<"writerFrontiers" | "sparseSeenCommits" | "observedRegisters" | "pendingApply", StateJsonValue>>,
): Promise<DurableStateSnapshot<StateJsonValue>> {
  return store.update((current) => {
    if (!isRecord(current)) throw new Error("repository state is missing");
    validateRepositoryStatePayload(current);
    const entries = parseDurableOutboxEntries(current.durableOutbox);
    const entry = entries.find((candidate) => candidate.id === outboxId);
    if (!entry || entry.commitHash !== verifiedCommitHash) throw new Error("verified Commit does not match frozen Outbox");
    if (entry.state !== "publishing") throw new Error("Outbox is not publishing");
    const published = transitionDurableOutbox(entry, "published");
    const reconciles = parsePublishedReconciles(current.publishedReconciles);
    const nextReconciles = [...reconciles, ...createPublishedReconciles(published)];
    const merged: Record<string, StateJsonValue> = {
      ...current,
      ...verifiedStatePatch,
      durableOutbox: toJson(replaceOutbox(entries, published)),
      outboxRefs: toJson(replaceOutbox(entries, published).map(outboxReference)),
      publishedReconciles: toJson(nextReconciles),
    };
    // 发布确认只能新增对账记录，不能顺带清理 dirtyIntent 或 projection。
    if (current.dirtyIntents !== merged.dirtyIntents || current.projections !== merged.projections) {
      throw new Error("publish confirmation cannot mutate dirty intent or projection");
    }
    validateRepositoryStatePayload(merged);
    return merged;
  });
}

export function validateRepositoryStatePayload(value: StateJsonValue): ReturnType<typeof parseRepositoryDurablePayload> {
  if (!isRecord(value)) throw new Error("repository transaction payload must be an object");
  const identity = parseRepositoryDurablePayload(value);
  validateRecordMap(value.dirtyIntents, "dirtyIntents");
  validateProjections(value.projections);
  validateOutboxReferences(value.outboxRefs);
  validateSparseSeenCommits(value.sparseSeenCommits);
  validateObservedRegisters(value.observedRegisters);
  validatePendingApply(value.pendingApply);
  validateLocalConcurrentRecords(value.localConcurrentRecords);
  validatePublishedReconciles(value.publishedReconciles);
  validateRecoveryRecords(value.recoveryRecords);
  parseDurableOutboxEntries(value.durableOutbox);
  return identity;
}

async function updateDurableOutbox(
  store: DurableStateStore<StateJsonValue>,
  update: (entries: DurableOutboxEntry[], identity: ReturnType<typeof parseRepositoryDurablePayload>) => DurableOutboxEntry[],
): Promise<DurableStateSnapshot<StateJsonValue>> {
  return store.update((current) => {
    if (!isRecord(current)) throw new Error("repository state is missing");
    const identity = validateRepositoryStatePayload(current);
    const entries = update(parseDurableOutboxEntries(current.durableOutbox), identity);
    assertDurableOutboxQueue(entries);
    const merged: Record<string, StateJsonValue> = {
      ...current,
      durableOutbox: toJson(entries),
      outboxRefs: toJson(entries.map(outboxReference)),
    };
    validateRepositoryStatePayload(merged);
    return merged;
  });
}

function validateProjections(value: StateJsonValue | undefined): void {
  if (!isRecord(value)) throw new Error("repository transaction projections are invalid");
  for (const projection of Object.values(value)) {
    if (!isRecord(projection) || !Array.isArray(projection.projectedHeads)
      || projection.projectedHeads.some((head) => typeof head !== "string")
      || (projection.projectedValueHash !== null && typeof projection.projectedValueHash !== "string")
      || !Number.isSafeInteger(projection.generation) || (projection.generation as number) < 0) {
      throw new Error("repository transaction projection is invalid");
    }
  }
}

function validateOutboxReferences(value: StateJsonValue | undefined): void {
  if (!Array.isArray(value)) throw new Error("repository transaction Outbox references are invalid");
  const sequences = new Map<string, { id: string; commitHash: string }>();
  for (const raw of value) {
    if (!isRecord(raw)) throw new Error("repository transaction Outbox reference is invalid");
    const reference = raw as unknown as DurableOutboxReference;
    if (![reference.id, reference.writerId, reference.commitHash, reference.stagedPath].every((item) => typeof item === "string" && item.length > 0)
      || !/^[0-9]{20}$/.test(reference.sequence) || !/^[0-9a-f]{64}$/.test(reference.commitHash)
      || !Number.isSafeInteger(reference.captureGeneration) || reference.captureGeneration < 0) {
      throw new Error("repository transaction Outbox reference is invalid");
    }
    const key = `${reference.writerId}:${reference.sequence}`;
    const existing = sequences.get(key);
    if (existing && (existing.id !== reference.id || existing.commitHash !== reference.commitHash)) {
      throw new Error("repository transaction reuses a writer sequence");
    }
    sequences.set(key, { id: reference.id, commitHash: reference.commitHash });
  }
}

function validateObservedRegisters(value: StateJsonValue | undefined): void {
  if (!isRecord(value)) throw new Error("repository transaction observed registers are invalid");
  for (const [key, observation] of Object.entries(value)) {
    if (!isRecord(observation) || !["resolved", "concurrent", "pending", "invalid"].includes(observation.disposition as string)
      || observation.key !== key
      || !stringArray(observation.heads) || !stringArray(observation.pending) || !stringArray(observation.invalid)
      || (observation.valueHash !== undefined && observation.valueHash !== null && typeof observation.valueHash !== "string")) {
      throw new Error("repository transaction observed register is invalid");
    }
  }
}

function validateSparseSeenCommits(value: StateJsonValue | undefined): void {
  if (!isRecord(value)) throw new Error("repository transaction sparse seen commits are invalid");
  for (const [hash, anchor] of Object.entries(value)) {
    if (!isRecord(anchor) || anchor.hash !== hash || !/^[0-9a-f]{64}$/.test(hash)
      || typeof anchor.key !== "string" || typeof anchor.writerId !== "string"
      || typeof anchor.sequence !== "string" || !/^[0-9]{20}$/.test(anchor.sequence)
      || (anchor.previousCommitHash !== null && (typeof anchor.previousCommitHash !== "string" || !/^[0-9a-f]{64}$/.test(anchor.previousCommitHash)))) {
      throw new Error("repository transaction sparse seen Commit is invalid");
    }
  }
}

function validatePendingApply(value: StateJsonValue | undefined): void {
  if (!isRecord(value)) throw new Error("repository transaction pending apply is invalid");
  for (const pending of Object.values(value)) {
    if (!isRecord(pending) || !stringArray(pending.targetHeads)
      || (pending.targetValueHash !== null && typeof pending.targetValueHash !== "string")) {
      throw new Error("repository transaction pending apply is invalid");
    }
  }
}

function validateLocalConcurrentRecords(value: StateJsonValue | undefined): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error("repository transaction LocalConcurrentRecords are invalid");
  for (const [path, raw] of Object.entries(value)) {
    if (!isRecord(raw) || raw.path !== path || !Number.isSafeInteger(raw.generation) || (raw.generation as number) <= 0
      || !stringArray(raw.basisHeads) || !isRecord(raw.editorValue) || !isRecord(raw.externalValue)) {
      throw new Error("repository transaction LocalConcurrentRecord is invalid");
    }
    validateConfirmedLocalValue(raw.editorValue);
    validateConfirmedLocalValue(raw.externalValue);
  }
}

function validateConfirmedLocalValue(value: Record<string, StateJsonValue>): void {
  if (value.kind === "put") {
    if (!isRecord(value.blob) || !/^[0-9a-f]{64}$/.test(value.blob.hash as string)
      || !Number.isSafeInteger(value.blob.size) || (value.blob.size as number) < 0
      || typeof value.stagedPath !== "string" || value.stagedPath.length === 0) {
      throw new Error("repository transaction staged local put is invalid");
    }
    return;
  }
  if (value.kind !== "delete" || !isRecord(value.evidence)) throw new Error("repository transaction confirmed local value is invalid");
}

function validatePublishedReconciles(value: StateJsonValue | undefined): void {
  if (value === undefined) return;
  const reconciles = parsePublishedReconciles(value);
  const identities = new Set<string>();
  for (const reconcile of reconciles) {
    const identity = `${reconcile.outboxId}:${reconcile.registerKey}:${reconcile.publishedVersionId}`;
    if (identities.has(identity)) throw new Error("repository transaction PublishedReconcile is duplicated");
    identities.add(identity);
  }
}

function parsePublishedReconciles(value: StateJsonValue | undefined): Array<ReturnType<typeof createPublishedReconciles>[number]> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("repository transaction PublishedReconciles are invalid");
  return value.map((raw) => {
    if (!isRecord(raw) || ![raw.outboxId, raw.registerKey, raw.publishedVersionId].every((item) => typeof item === "string" && item.length > 0)
      || !Number.isSafeInteger(raw.generation) || (raw.generation as number) < 0
      || (raw.publishedValueHash !== null && (typeof raw.publishedValueHash !== "string" || !/^[0-9a-f]{64}$/.test(raw.publishedValueHash)))
      || !["pending", "adopted", "next-generation"].includes(raw.state as string)
      || (raw.stagedContentRef !== undefined && typeof raw.stagedContentRef !== "string")) {
      throw new Error("repository transaction PublishedReconcile is invalid");
    }
    return raw as unknown as ReturnType<typeof createPublishedReconciles>[number];
  });
}

function validateRecoveryRecords(value: StateJsonValue | undefined): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error("repository transaction recovery records are invalid");
  for (const [id, raw] of Object.entries(value)) {
    if (!isRecord(raw) || raw.id !== id || typeof raw.contentRef !== "string" || typeof raw.logicalPath !== "string"
      || !/^[0-9a-f]{64}$/.test(raw.capturedHash as string) || !/^[0-9a-f]{64}$/.test(raw.lastStableHash as string)
      || !Number.isSafeInteger(raw.capturedSize) || !Number.isSafeInteger(raw.lastStableSize)
      || typeof raw.postCaptureEdit !== "boolean" || !["retained", "cleanup-requested", "cleaned"].includes(raw.cleanupState as string)) {
      throw new Error("repository transaction recovery record is invalid");
    }
  }
}

function parseDurableOutboxEntries(value: StateJsonValue | undefined): DurableOutboxEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("repository transaction durable Outbox is invalid");
  const entries = value.map((raw) => {
    if (!isRecord(raw) || !Array.isArray(raw.objects) || !Array.isArray(raw.mutations)
      || typeof raw.id !== "string" || typeof raw.writerId !== "string" || typeof raw.sequence !== "string"
      || (raw.previousCommitHash !== null && typeof raw.previousCommitHash !== "string")
      || typeof raw.commitHash !== "string" || !Number.isSafeInteger(raw.captureGeneration)
      || !["queued", "publishing", "published", "retryable-error", "integrity-error", "recovery-required"].includes(raw.state as string)
      || !["active", "forked-draining"].includes(raw.writerDisposition as string)) {
      throw new Error("repository transaction durable Outbox entry is invalid");
    }
    for (const object of raw.objects) {
      if (!isRecord(object) || !["blob", "config-tree", "change-chunk", "commit"].includes(object.kind as string)
        || typeof object.key !== "string" || typeof object.hash !== "string" || typeof object.contentRef !== "string"
        || !Number.isSafeInteger(object.size) || (object.size as number) < 0) {
        throw new Error("repository transaction durable Outbox object is invalid");
      }
    }
    for (const mutation of raw.mutations) {
      if (!isRecord(mutation) || typeof mutation.registerKey !== "string" || typeof mutation.versionId !== "string"
        || (mutation.valueHash !== null && typeof mutation.valueHash !== "string")
        || (mutation.stagedContentRef !== undefined && typeof mutation.stagedContentRef !== "string")) {
        throw new Error("repository transaction durable Outbox Mutation is invalid");
      }
    }
    return raw as unknown as DurableOutboxEntry;
  });
  assertDurableOutboxQueue(entries);
  return entries;
}

function replaceOutbox(entries: readonly DurableOutboxEntry[], replacement: DurableOutboxEntry): DurableOutboxEntry[] {
  return entries.map((entry) => entry.id === replacement.id ? replacement : entry);
}

function outboxReference(entry: DurableOutboxEntry): DurableOutboxReference {
  return {
    id: entry.id,
    writerId: entry.writerId,
    sequence: entry.sequence,
    commitHash: entry.commitHash,
    stagedPath: entry.objects.at(-1)!.contentRef,
    captureGeneration: entry.captureGeneration,
  };
}

function toJson(value: unknown): StateJsonValue {
  return JSON.parse(JSON.stringify(value)) as StateJsonValue;
}

function validateRecordMap(value: StateJsonValue | undefined, name: string): void {
  if (!isRecord(value)) throw new Error(`repository transaction ${name} is invalid`);
}

function stringArray(value: StateJsonValue | undefined): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: StateJsonValue | undefined): value is Record<string, StateJsonValue> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
