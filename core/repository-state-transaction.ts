import type { DurableStateSnapshot, DurableStateStore, StateJsonValue } from "./durable-state";
import {
  assertDurableOutboxQueue,
  createPublishedReconciles,
  forkedWriterDisposition,
  markWriterForked,
  nextDurableOutbox,
  transitionDurableOutbox,
  type DurableOutboxEntry,
} from "./durable-outbox";
import { normalizeRepositoryStateReference } from "./local-state-layout";
import type { PersistedLocalConcurrentRecord } from "./local-concurrent-resolution";
import type { RecoveryRecord } from "./recovery-record";
import { advanceWriterFrontiers } from "./commit-frontier";
import { parseVersionId } from "./version-id";
import { repositoryFingerprint, type RepositoryLocator } from "./locator";
import { canonicalizeProtocolJson } from "../protocol/json";
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

export interface WaitingRootDelete {
  registerKey: string;
  projectionKey: string;
  rootOutboxId: string;
  localPredecessorVersion: string;
  generation: number;
  evidence: StateJsonValue;
  state: "waiting-publication" | "ready";
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

export async function rebindVerifiedRepositoryRouteStateTransaction(
  store: DurableStateStore<StateJsonValue>,
  candidateLocator: RepositoryLocator,
): Promise<DurableStateSnapshot<StateJsonValue>> {
  return store.update((current) => {
    if (!isRecord(current)) throw new Error("repository state is missing");
    const identity = validateRepositoryStatePayload(current);
    if (candidateLocator.bucket !== identity.locator.bucket
      || candidateLocator.normalizedPrefix !== identity.locator.normalizedPrefix) {
      throw new Error("Bucket or Prefix change requires non-destructive reattachment");
    }
    const nextFingerprint = repositoryFingerprint(candidateLocator, identity.repositoryId, identity.descriptorHash);
    const entries = parseDurableOutboxEntries(current.durableOutbox).map((entry) => ({
      ...entry,
      repositoryFingerprint: nextFingerprint,
    }));
    const merged: Record<string, StateJsonValue> = {
      ...current,
      locator: toJson(candidateLocator),
      repositoryFingerprint: nextFingerprint,
      durableOutbox: toJson(entries),
      outboxRefs: toJson(entries.map(outboxReference)),
    };
    validateRepositoryStatePayload(merged);
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
    if (entry.repositoryFingerprint !== identity.repositoryFingerprint) throw new Error("Outbox belongs to another repository binding");
    if (isRecord(current.writerForkState) && current.writerForkState.writerId === identity.writerId) {
      throw new Error("forked writer cannot freeze a new Outbox");
    }
    if (entry.writerId !== identity.writerId || entry.sequence !== identity.nextSequence
      || entry.previousCommitHash !== identity.previousCommitHash) {
      throw new Error("Outbox reservation does not match the durable writer cursor");
    }
    const entries = parseDurableOutboxEntries(current.durableOutbox);
    if (entries.some((existing) => existing.writerId === identity.writerId
      && (existing.state === "integrity-error" || existing.state === "recovery-required"))) {
      throw new Error("active writer chain requires recovery before freezing new work");
    }
    if (entries.some((existing) => existing.id === entry.id)) throw new Error("Outbox Commit is already frozen");
    if (isMaximumSequence(entry.sequence) && entries.some((existing) => existing.writerId === entry.writerId && existing.sequence === entry.sequence)) {
      throw new Error("maximum writer sequence is already allocated");
    }
    const nextEntries = [...entries, entry];
    assertDurableOutboxQueue(nextEntries);
    const waitingRootDeletes = consumeReadyRootDeletes(current.waitingRootDeletes, entry);
    const localPredecessors = { ...recordOrEmpty(current.localPredecessors) };
    const localPredecessorHistory = { ...recordOrEmpty(current.localPredecessorHistory) };
    for (const mutation of entry.mutations) {
      localPredecessors[mutation.registerKey] = mutation.versionId;
      localPredecessorHistory[`${entry.id}:${mutation.registerKey}`] = mutation.versionId;
    }
    const merged: Record<string, StateJsonValue> = {
      ...current,
      ...causalPatch,
      durableOutbox: toJson(nextEntries),
      outboxRefs: toJson(nextEntries.map(outboxReference)),
      previousCommitHash: entry.commitHash,
      nextSequence: isMaximumSequence(entry.sequence) ? entry.sequence : nextSequence(entry.sequence),
      writerRotationPending: isMaximumSequence(entry.sequence),
      localPredecessors,
      localPredecessorHistory,
      waitingRootDeletes,
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
  verifiedStatePatch: {
    observedRegisters: StateJsonValue;
    pendingApply: StateJsonValue;
    writerFrontiers?: StateJsonValue;
    sparseSeenCommits?: StateJsonValue;
  },
): Promise<DurableStateSnapshot<StateJsonValue>> {
  return store.update((current) => {
    if (!isRecord(current)) throw new Error("repository state is missing");
    const identity = validateRepositoryStatePayload(current);
    const patchedIdentity = verifiedStatePatch.writerFrontiers === undefined
      ? identity
      : parseRepositoryDurablePayload({ ...current, writerFrontiers: verifiedStatePatch.writerFrontiers });
    const entries = parseDurableOutboxEntries(current.durableOutbox);
    const entry = entries.find((candidate) => candidate.id === outboxId);
    if (!entry || entry.commitHash !== verifiedCommitHash) throw new Error("verified Commit does not match frozen Outbox");
    if (entry.state !== "publishing") throw new Error("Outbox is not publishing");
    const published = transitionDurableOutbox(entry, "published");
    const commitObject = entry.objects.at(-1)!;
    const anchor = {
      key: commitObject.key,
      writerId: entry.writerId,
      sequence: entry.sequence,
      hash: entry.commitHash,
      previousCommitHash: entry.previousCommitHash,
    };
    const reconciles = parsePublishedReconciles(current.publishedReconciles);
    const nextReconciles = [...reconciles, ...createPublishedReconciles(published)];
    const waitingRootDeletes = markRootDeletesReady(current.waitingRootDeletes, published.id);
    const sparseSeenCommits = {
      ...recordOrEmpty(current.sparseSeenCommits),
      ...recordOrEmpty(verifiedStatePatch.sparseSeenCommits),
      [anchor.hash]: toJson(anchor),
    };
    const verifiedLocalPublications = { ...recordOrEmpty(current.verifiedLocalPublications) };
    for (const mutation of published.mutations) {
      verifiedLocalPublications[mutation.versionId] = {
        outboxId: published.id,
        registerKey: mutation.registerKey,
        commitHash: published.commitHash,
      };
    }
    const merged: Record<string, StateJsonValue> = {
      ...current,
      ...verifiedStatePatch,
      writerFrontiers: toJson(advanceWriterFrontiers(patchedIdentity.writerFrontiers, [anchor])),
      sparseSeenCommits,
      verifiedLocalPublications,
      durableOutbox: toJson(replaceOutbox(entries, published)),
      outboxRefs: toJson(replaceOutbox(entries, published).map(outboxReference)),
      publishedReconciles: toJson(nextReconciles),
      waitingRootDeletes,
    };
    // 发布确认只能新增对账记录，不能顺带清理 dirtyIntent 或 projection。
    if (current.dirtyIntents !== merged.dirtyIntents || current.projections !== merged.projections) {
      throw new Error("publish confirmation cannot mutate dirty intent or projection");
    }
    validateRepositoryStatePayload(merged);
    return merged;
  });
}

export async function queueDeleteAfterFrozenRootPutTransaction(
  store: DurableStateStore<StateJsonValue>,
  input: Omit<WaitingRootDelete, "localPredecessorVersion" | "state">,
): Promise<DurableStateSnapshot<StateJsonValue>> {
  return store.update((current) => {
    if (!isRecord(current)) throw new Error("repository state is missing");
    validateRepositoryStatePayload(current);
    const rootOutbox = parseDurableOutboxEntries(current.durableOutbox).find((entry) => entry.id === input.rootOutboxId);
    const rootMutation = rootOutbox?.mutations.find((mutation) => mutation.registerKey === input.registerKey);
    if (!rootOutbox || !["queued", "publishing", "published"].includes(rootOutbox.state)
      || !rootMutation || rootMutation.kind !== "put" || rootMutation.parents.length !== 0) {
      throw new Error("waiting delete must reference a frozen root put");
    }
    if (!Number.isSafeInteger(input.generation) || input.generation <= rootOutbox.captureGeneration || !isRecord(input.evidence)) {
      throw new Error("waiting root delete generation or evidence is invalid");
    }
    const waiting = { ...recordOrEmpty(current.waitingRootDeletes) };
    if (waiting[input.registerKey] !== undefined) throw new Error("waiting root delete already exists");
    waiting[input.registerKey] = toJson({
      ...input,
      localPredecessorVersion: rootMutation.versionId,
      state: rootOutbox.state === "published" ? "ready" : "waiting-publication",
    } satisfies WaitingRootDelete);
    const merged: Record<string, StateJsonValue> = { ...current, waitingRootDeletes: waiting };
    validateRepositoryStatePayload(merged);
    return merged;
  });
}

export async function markDurableWriterForkTransaction(
  store: DurableStateStore<StateJsonValue>,
  writerId: string,
  verifiedOutboxIds: ReadonlySet<string>,
): Promise<DurableStateSnapshot<StateJsonValue>> {
  return store.update((current) => {
    if (!isRecord(current)) throw new Error("repository state is missing");
    const identity = validateRepositoryStatePayload(current);
    if (identity.writerId !== writerId) throw new Error("writer fork does not match the active writer");
    let entries = markWriterForked(parseDurableOutboxEntries(current.durableOutbox), writerId);
    const disposition = forkedWriterDisposition(entries, writerId, verifiedOutboxIds);
    if (disposition === "recovery-required") {
      entries = entries.map((entry) => entry.writerId === writerId && entry.state !== "published" && entry.state !== "recovery-required"
        ? transitionDurableOutbox(entry, "recovery-required")
        : entry);
    }
    const merged: Record<string, StateJsonValue> = {
      ...current,
      durableOutbox: toJson(entries),
      outboxRefs: toJson(entries.map(outboxReference)),
      writerForkState: { writerId, disposition },
    };
    validateRepositoryStatePayload(merged);
    return merged;
  });
}

export async function rotateDrainedDurableWriterTransaction(
  store: DurableStateStore<StateJsonValue>,
  nextWriterId: string,
): Promise<DurableStateSnapshot<StateJsonValue>> {
  return store.update((current) => {
    if (!isRecord(current)) throw new Error("repository state is missing");
    const identity = validateRepositoryStatePayload(current);
    if (!isRecord(current.writerForkState) || current.writerForkState.writerId !== identity.writerId) {
      throw new Error("active writer is not forked");
    }
    const entries = parseDurableOutboxEntries(current.durableOutbox);
    if (forkedWriterDisposition(entries, identity.writerId, new Set(entries.map((entry) => entry.id))) !== "rotate") {
      throw new Error("forked writer Outbox is not drained");
    }
    if (nextWriterId.length === 0 || nextWriterId === identity.writerId) throw new Error("replacement writerId must be new");
    const merged: Record<string, StateJsonValue> = {
      ...current,
      writerId: nextWriterId,
      nextSequence: "00000000000000000001",
      previousCommitHash: null,
      writerRotationPending: false,
    };
    delete merged.writerForkState;
    validateRepositoryStatePayload(merged);
    return merged;
  });
}

export async function persistLocalConcurrentRecordTransaction(
  store: DurableStateStore<StateJsonValue>,
  record: PersistedLocalConcurrentRecord,
): Promise<DurableStateSnapshot<StateJsonValue>> {
  return store.update((current) => {
    if (!isRecord(current)) throw new Error("repository state is missing");
    validateRepositoryStatePayload(current);
    const records = { ...recordOrEmpty(current.localConcurrentRecords), [record.path]: toJson(record) };
    assertLocalConcurrentTransition(recordOrEmpty(current.localConcurrentRecords)[record.path], record);
    const merged: Record<string, StateJsonValue> = { ...current, localConcurrentRecords: records };
    validateRepositoryStatePayload(merged);
    return merged;
  });
}

export async function clearPublishedLocalConcurrentRecordTransaction(
  store: DurableStateStore<StateJsonValue>,
  path: string,
): Promise<DurableStateSnapshot<StateJsonValue>> {
  return store.update((current) => {
    if (!isRecord(current)) throw new Error("repository state is missing");
    validateRepositoryStatePayload(current);
    const records = { ...recordOrEmpty(current.localConcurrentRecords) };
    const record = records[path];
    if (!isRecord(record) || !isRecord(record.selection) || record.selection.state !== "published") {
      throw new Error("LocalConcurrentRecord resolution is not published");
    }
    const retainedRecoveryRefs = new Set(recordValues(current.recoveryRecords)
      .flatMap((candidate) => isRecord(candidate) && typeof candidate.contentRef === "string" ? [candidate.contentRef] : []));
    if (Array.isArray(record.selection.unselectedContentRefs)
      && record.selection.unselectedContentRefs.some((reference) => typeof reference !== "string" || !retainedRecoveryRefs.has(reference))) {
      throw new Error("LocalConcurrentRecord has unretained recovery content");
    }
    delete records[path];
    const merged: Record<string, StateJsonValue> = { ...current, localConcurrentRecords: records };
    validateRepositoryStatePayload(merged);
    return merged;
  });
}

export async function persistRecoveryRecordTransaction(
  store: DurableStateStore<StateJsonValue>,
  record: RecoveryRecord,
): Promise<DurableStateSnapshot<StateJsonValue>> {
  return store.update((current) => {
    if (!isRecord(current)) throw new Error("repository state is missing");
    validateRepositoryStatePayload(current);
    const records = { ...recordOrEmpty(current.recoveryRecords) };
    const previous = records[record.id];
    assertRecoveryTransition(previous, record);
    records[record.id] = toJson(record);
    const merged: Record<string, StateJsonValue> = { ...current, recoveryRecords: records };
    validateRepositoryStatePayload(merged);
    return merged;
  });
}

export type PublishedReconcileObservation =
  | { kind: "put"; hash: string; size: number; stagedPath: string }
  | { kind: "delete"; evidence: StateJsonValue }
  | { kind: "unknown" };

export async function reconcilePublishedMutationStateTransaction(
  store: DurableStateStore<StateJsonValue>,
  input: {
    outboxId: string;
    registerKey: string;
    projectionKey: string;
    observation: PublishedReconcileObservation;
    hasNewDirtyIntent?: boolean;
  },
): Promise<DurableStateSnapshot<StateJsonValue>> {
  return store.update((current) => {
    if (!isRecord(current)) throw new Error("repository state is missing");
    validateRepositoryStatePayload(current);
    const reconciles = parsePublishedReconciles(current.publishedReconciles);
    const index = reconciles.findIndex((candidate) => candidate.outboxId === input.outboxId && candidate.registerKey === input.registerKey);
    if (index < 0 || reconciles[index].state !== "pending") throw new Error("pending PublishedReconcile was not found");
    if (input.observation.kind === "unknown") return current;

    const reconcile = reconciles[index];
    const dirtyIntents = { ...recordOrEmpty(current.dirtyIntents) };
    const existingDirty = dirtyIntents[input.projectionKey];
    const existingGeneration = isRecord(existingDirty) && Number.isSafeInteger(existingDirty.generation)
      ? existingDirty.generation as number
      : 0;
    const hasNewDirtyIntent = input.hasNewDirtyIntent === true || existingGeneration > reconcile.generation;
    const observedHash = input.observation.kind === "put" ? input.observation.hash : null;
    const adopted = !hasNewDirtyIntent && observedHash === reconcile.publishedValueHash;
    reconciles[index] = { ...reconcile, state: adopted ? "adopted" : "next-generation" };

    const projections = { ...recordOrEmpty(current.projections) };
    const currentProjection = isRecord(projections[input.projectionKey]) ? projections[input.projectionKey] : undefined;
    projections[input.projectionKey] = {
      projectedHeads: [reconcile.publishedVersionId],
      projectedValueHash: reconcile.publishedValueHash,
      generation: Math.max(reconcile.generation, isRecord(currentProjection) && Number.isSafeInteger(currentProjection.generation) ? currentProjection.generation as number : 0),
    };

    if (adopted) {
      if (existingGeneration <= reconcile.generation) delete dirtyIntents[input.projectionKey];
    } else {
      const localPredecessorHistory = recordOrEmpty(current.localPredecessorHistory);
      if (localPredecessorHistory[`${reconcile.outboxId}:${input.registerKey}`] !== reconcile.publishedVersionId) {
        throw new Error("PublishedReconcile local predecessor is not the frozen Version ID");
      }
      dirtyIntents[input.projectionKey] = nextDirtyIntent(existingDirty, {
        projectionKey: input.projectionKey,
        observation: input.observation,
      }, reconcile.publishedVersionId, reconcile.generation);
    }

    const merged: Record<string, StateJsonValue> = {
      ...current,
      dirtyIntents,
      projections,
      publishedReconciles: toJson(reconciles),
    };
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
  validateLocalPredecessors(value.localPredecessors);
  validateLocalPredecessors(value.localPredecessorHistory);
  validateWaitingRootDeletes(value.waitingRootDeletes);
  validateWriterForkState(value.writerForkState);
  validateVerifiedLocalPublications(value.verifiedLocalPublications);
  const entries = parseDurableOutboxEntries(value.durableOutbox);
  if (entries.some((entry) => entry.repositoryFingerprint !== identity.repositoryFingerprint)) {
    throw new Error("repository transaction Outbox belongs to another repository binding");
  }
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
    assertStateReference(reference.stagedPath);
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
    if (raw.selection !== undefined) validateLocalConcurrentSelection(raw.selection, path, raw.basisHeads as string[]);
  }
}

function validateLocalConcurrentSelection(value: StateJsonValue, path: string, basisHeads: string[]): void {
  if (!isRecord(value) || value.path !== path || !["editor", "external", "merged", "delete"].includes(value.choice as string)
    || !["selected", "published"].includes(value.state as string) || !stringArray(value.parents)
    || !sameStrings(value.parents, basisHeads) || !Array.isArray(value.unselectedContentRefs)
    || value.unselectedContentRefs.some((reference) => typeof reference !== "string")) {
    throw new Error("repository transaction LocalConcurrentRecord selection is invalid");
  }
  validateConfirmedLocalValue(recordValue(value.value, "LocalConcurrentRecord selected value"));
  for (const reference of value.unselectedContentRefs as string[]) assertStateReference(reference);
}

function validateConfirmedLocalValue(value: Record<string, StateJsonValue>): void {
  if (value.kind === "put") {
    if (!isRecord(value.blob) || !/^[0-9a-f]{64}$/.test(value.blob.hash as string)
      || !Number.isSafeInteger(value.blob.size) || (value.blob.size as number) < 0
      || typeof value.stagedPath !== "string" || value.stagedPath.length === 0) {
      throw new Error("repository transaction staged local put is invalid");
    }
    assertStateReference(value.stagedPath as string);
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
    if (raw.stagedContentRef !== undefined) assertStateReference(raw.stagedContentRef as string);
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
      || !Number.isSafeInteger(raw.capturedAt) || (raw.capturedAt as number) < 0
      || !["apply-before-image", "config-rollback", "conflict-draft", "local-concurrent", "post-capture-edit", "state-loss-onboarding"].includes(raw.source as string)
      || typeof raw.postCaptureEdit !== "boolean" || !["retained", "cleanup-requested", "cleaned"].includes(raw.cleanupState as string)) {
      throw new Error("repository transaction recovery record is invalid");
    }
    assertStateReference(raw.contentRef as string);
  }
}

function validateLocalPredecessors(value: StateJsonValue | undefined): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error("repository transaction local predecessors are invalid");
  for (const [registerKey, versionId] of Object.entries(value)) {
    if (registerKey.length === 0 || typeof versionId !== "string" || !isVersionId(versionId)) {
      throw new Error("repository transaction local predecessor is invalid");
    }
  }
}

function validateWaitingRootDeletes(value: StateJsonValue | undefined): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error("repository transaction waiting root deletes are invalid");
  for (const [registerKey, raw] of Object.entries(value)) {
    if (!isRecord(raw) || raw.registerKey !== registerKey || typeof raw.projectionKey !== "string"
      || typeof raw.rootOutboxId !== "string" || typeof raw.localPredecessorVersion !== "string"
      || !Number.isSafeInteger(raw.generation) || (raw.generation as number) <= 0 || !isRecord(raw.evidence)
      || !["waiting-publication", "ready"].includes(raw.state as string)) {
      throw new Error("repository transaction waiting root delete is invalid");
    }
  }
}

function validateWriterForkState(value: StateJsonValue | undefined): void {
  if (value === undefined) return;
  if (!isRecord(value) || typeof value.writerId !== "string"
    || !["drain", "rotate", "recovery-required"].includes(value.disposition as string)) {
    throw new Error("repository transaction writer fork state is invalid");
  }
}

function validateVerifiedLocalPublications(value: StateJsonValue | undefined): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error("repository transaction verified local publications are invalid");
  for (const [versionId, raw] of Object.entries(value)) {
    if (!isVersionId(versionId) || !isRecord(raw) || typeof raw.outboxId !== "string"
      || typeof raw.registerKey !== "string" || typeof raw.commitHash !== "string"
      || !/^[0-9a-f]{64}$/.test(raw.commitHash) || parseVersionId(versionId).commitHash !== raw.commitHash) {
      throw new Error("repository transaction verified local publication is invalid");
    }
  }
}

function parseDurableOutboxEntries(value: StateJsonValue | undefined): DurableOutboxEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("repository transaction durable Outbox is invalid");
  const entries = value.map((raw) => {
    if (!isRecord(raw) || !Array.isArray(raw.objects) || !Array.isArray(raw.mutations)
      || typeof raw.id !== "string" || typeof raw.repositoryFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(raw.repositoryFingerprint)
      || typeof raw.writerId !== "string" || typeof raw.sequence !== "string"
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
      assertStateReference(object.contentRef as string);
    }
    for (const mutation of raw.mutations) {
      if (!isRecord(mutation) || typeof mutation.registerKey !== "string" || typeof mutation.versionId !== "string"
        || !["put", "delete", "config-snapshot"].includes(mutation.kind as string) || !stringArray(mutation.parents)
        || (mutation.valueHash !== null && typeof mutation.valueHash !== "string")
        || (mutation.stagedContentRef !== undefined && typeof mutation.stagedContentRef !== "string")) {
        throw new Error("repository transaction durable Outbox Mutation is invalid");
      }
      if (mutation.stagedContentRef !== undefined) assertStateReference(mutation.stagedContentRef as string);
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

function nextDirtyIntent(
  current: StateJsonValue | undefined,
  input: { projectionKey: string; observation: Exclude<PublishedReconcileObservation, { kind: "unknown" }> },
  localPredecessorVersion: string,
  publishedGeneration: number,
): StateJsonValue {
  const existing = isRecord(current) ? current : {};
  const generation = Math.max(
    publishedGeneration + 1,
    Number.isSafeInteger(existing.generation) ? existing.generation as number : 0,
  );
  const base: Record<string, StateJsonValue> = {
    ...existing,
    path: input.projectionKey,
    queueId: input.projectionKey,
    generation,
    basisHeads: [],
    localPredecessorVersion,
    awaitingLocalWrite: existing.awaitingLocalWrite === true,
  };
  if (!isRecord(current) || current.value === undefined) {
    base.value = input.observation.kind === "put"
      ? { kind: "put", blob: { hash: input.observation.hash, size: input.observation.size }, stagedPath: input.observation.stagedPath }
      : { kind: "delete", evidence: input.observation.evidence };
  }
  return base;
}

function assertRecoveryTransition(previous: StateJsonValue | undefined, next: RecoveryRecord): void {
  if (!isRecord(previous)) {
    if (next.cleanupState !== "retained") throw new Error("new recovery record must start retained");
    return;
  }
  for (const key of ["id", "contentRef", "logicalPath", "source", "capturedHash", "capturedSize", "capturedAt"] as const) {
    if (previous[key] !== next[key]) throw new Error("recovery record identity changed");
  }
  const allowed: Record<string, string[]> = {
    retained: ["retained", "cleanup-requested"],
    "cleanup-requested": ["retained", "cleanup-requested", "cleaned"],
    cleaned: ["cleaned"],
  };
  if (!allowed[String(previous.cleanupState)]?.includes(next.cleanupState)) throw new Error("invalid recovery cleanup transition");
}

function consumeReadyRootDeletes(value: StateJsonValue | undefined, entry: DurableOutboxEntry): Record<string, StateJsonValue> {
  const waiting = { ...recordOrEmpty(value) };
  for (const mutation of entry.mutations) {
    if (mutation.kind === "delete" && mutation.parents.length === 0) throw new Error("root delete Outbox is forbidden");
    const raw = waiting[mutation.registerKey];
    if (!isRecord(raw)) continue;
    if (mutation.kind !== "delete" || raw.state !== "ready"
      || mutation.parents.length !== 1 || mutation.parents[0] !== raw.localPredecessorVersion) {
      throw new Error("waiting root delete cannot freeze before its root put is verified");
    }
    delete waiting[mutation.registerKey];
  }
  return waiting;
}

function markRootDeletesReady(value: StateJsonValue | undefined, rootOutboxId: string): Record<string, StateJsonValue> {
  return Object.fromEntries(Object.entries(recordOrEmpty(value)).map(([registerKey, raw]) => [registerKey,
    isRecord(raw) && raw.rootOutboxId === rootOutboxId ? { ...raw, state: "ready" } : raw]));
}

function assertStateReference(reference: string): void {
  normalizeRepositoryStateReference(reference);
}

function recordOrEmpty(value: StateJsonValue | undefined): Record<string, StateJsonValue> {
  return isRecord(value) ? value : {};
}

function recordValue(value: StateJsonValue | undefined, name: string): Record<string, StateJsonValue> {
  if (!isRecord(value)) throw new Error(`repository transaction ${name} is invalid`);
  return value;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertLocalConcurrentTransition(previous: StateJsonValue | undefined, next: PersistedLocalConcurrentRecord): void {
  if (!isRecord(previous)) return;
  if (previous.path !== next.path || previous.generation !== next.generation
    || !stringArray(previous.basisHeads) || !sameStrings(previous.basisHeads, next.basisHeads)) {
    throw new Error("LocalConcurrentRecord causal identity changed");
  }
  if (isRecord(previous.selection)) {
    if (previous.selection.state === "published"
      && canonicalizeProtocolJson(previous) !== canonicalizeProtocolJson(toJson(next))) {
      throw new Error("published LocalConcurrentRecord is immutable");
    }
    if (!next.selection || previous.selection.choice !== next.selection.choice
      || previous.selection.path !== next.selection.path || previous.selection.state === "published" && next.selection.state !== "published") {
      throw new Error("LocalConcurrentRecord selection regressed");
    }
  }
}

function isVersionId(value: string): boolean {
  try { parseVersionId(value); return true; } catch { return false; }
}

function recordValues(value: StateJsonValue | undefined): StateJsonValue[] {
  return isRecord(value) ? Object.values(value) : [];
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
