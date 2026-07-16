import type { DurableStateSnapshot, DurableStateStore, StateJsonValue } from "./durable-state";
import {
  assertDurableOutboxQueue,
  confirmRemotelyVerifiedTerminalOutbox,
  createPublishedReconciles,
  forkedWriterDisposition,
  markWriterForked,
  nextDurableOutbox,
  transitionDurableOutbox,
  type DurableOutboxEntry,
  type VerifiedTerminalOutboxProof,
} from "./durable-outbox";
import { normalizeRepositoryStateReference } from "./local-state-layout";
import type { PersistedLocalConcurrentRecord } from "./local-concurrent-resolution";
import type { RecoveryRecord } from "./recovery-record";
import { advanceWriterFrontiers } from "./commit-frontier";
import { parseVersionId } from "./version-id";
import { repositoryFingerprint } from "./locator";
import { canonicalizeProtocolJson } from "../protocol/json";
import { parseRepositoryDurablePayload } from "./repository-durable-payload";
import { isMaximumSequence, nextSequence } from "./sequence";
import { buildConfigTreeObject, type ProtocolConfigTree } from "./config-tree";
import { configBatchPlanHash, type ConfigBatchOperation, type ConfigBatchPlan } from "./config-batch-apply";
import { LOCAL_STATE_CONTAINER } from "./scope";
import { normalizeVaultPath } from "./path";
import {
  bindVaultEventsAfterPublication,
  latestVaultEvent,
  mergeVaultEventsAfterPublication,
  recordVaultEvent,
  type VaultEventIntent,
} from "./vault-event";

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

interface VerifiedOutboxStatePatch {
  observedRegisters: StateJsonValue;
  pendingApply: StateJsonValue;
  writerFrontiers?: StateJsonValue;
  sparseSeenCommits?: StateJsonValue;
  operationalStatus?: StateJsonValue;
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
      if (!isRecord(current)) throw new Error("repository transaction payload must be an object");
      const currentIdentity = validateRepositoryStatePayload(current);
      if (currentIdentity.repositoryFingerprint !== nextIdentity.repositoryFingerprint) throw new Error("repository transaction fingerprint changed");
      if (currentIdentity.writerId === nextIdentity.writerId && BigInt(nextIdentity.nextSequence) < BigInt(currentIdentity.nextSequence)) {
        throw new Error("repository transaction writer sequence regressed");
      }
      const currentEntries = parseDurableOutboxEntries(current.durableOutbox);
      const nextEntries = parseDurableOutboxEntries(merged.durableOutbox);
      assertDurableOutboxEvolution(currentEntries, nextEntries);
      assertConfigPublicationEvolution(current.configSync, merged.configSync, currentEntries, nextEntries);
      assertPublishedReconcileEvolution(
        parsePublishedReconciles(current.publishedReconciles),
        parsePublishedReconciles(merged.publishedReconciles),
      );
    }
    return merged;
  });
}

export async function freezeDurableOutboxStateTransaction(
  store: DurableStateStore<StateJsonValue>,
  entry: DurableOutboxEntry,
  causalPatch: Partial<Record<"dirtyIntents" | "projections" | "localConcurrentRecords" | "configSync", StateJsonValue>> = {},
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

export async function failDurableOutboxPublicationTransaction(
  store: DurableStateStore<StateJsonValue>,
  outboxId: string,
  failure: "retryable-error" | "integrity-error" | "recovery-required",
): Promise<DurableStateSnapshot<StateJsonValue>> {
  return updateDurableOutbox(store, (entries) => {
    const entry = entries.find((candidate) => candidate.id === outboxId);
    if (!entry || entry.state !== "publishing") throw new Error("publishing Outbox was not found");
    return replaceOutbox(entries, transitionDurableOutbox(entry, failure));
  });
}

export async function confirmDurableOutboxPublishedTransaction(
  store: DurableStateStore<StateJsonValue>,
  outboxId: string,
  verifiedCommitHash: string,
  verifiedStatePatch: VerifiedOutboxStatePatch,
): Promise<DurableStateSnapshot<StateJsonValue>> {
  return confirmVerifiedOutboxPublishedTransaction(store, outboxId, verifiedStatePatch, (entry) => {
    if (entry.commitHash !== verifiedCommitHash) throw new Error("verified Commit does not match frozen Outbox");
    if (entry.state !== "publishing") throw new Error("Outbox is not publishing");
    return transitionDurableOutbox(entry, "published");
  });
}

export async function confirmTerminalDurableOutboxPublishedTransaction(
  store: DurableStateStore<StateJsonValue>,
  proof: VerifiedTerminalOutboxProof,
  verifiedStatePatch: VerifiedOutboxStatePatch,
): Promise<DurableStateSnapshot<StateJsonValue>> {
  return confirmVerifiedOutboxPublishedTransaction(
    store,
    proof.outboxId,
    verifiedStatePatch,
    (entry) => confirmRemotelyVerifiedTerminalOutbox(entry, proof),
  );
}

async function confirmVerifiedOutboxPublishedTransaction(
  store: DurableStateStore<StateJsonValue>,
  outboxId: string,
  verifiedStatePatch: VerifiedOutboxStatePatch,
  publishEntry: (entry: DurableOutboxEntry) => DurableOutboxEntry,
): Promise<DurableStateSnapshot<StateJsonValue>> {
  return store.update((current) => {
    if (!isRecord(current)) throw new Error("repository state is missing");
    const identity = validateRepositoryStatePayload(current);
    const patchedIdentity = verifiedStatePatch.writerFrontiers === undefined
      ? identity
      : parseRepositoryDurablePayload({ ...current, writerFrontiers: verifiedStatePatch.writerFrontiers });
    const entries = parseDurableOutboxEntries(current.durableOutbox);
    const entry = entries.find((candidate) => candidate.id === outboxId);
    if (!entry) throw new Error("verified durable Outbox was not found");
    const published = publishEntry(entry);
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

export async function completePublishedConfigOutboxTransaction(
  store: DurableStateStore<StateJsonValue>,
  input: { outboxId: string; localTreeHash: string | null },
): Promise<DurableStateSnapshot<StateJsonValue>> {
  return store.update((current) => {
    if (!isRecord(current)) throw new Error("repository state is missing");
    validateRepositoryStatePayload(current);
    if (input.localTreeHash !== null && !isHash(input.localTreeHash)) throw new Error("local ConfigTree hash is invalid");
    const entries = parseDurableOutboxEntries(current.durableOutbox);
    const entry = entries.find((candidate) => candidate.id === input.outboxId);
    if (!entry || entry.state !== "published") throw new Error("config Outbox is not verified published");
    const mutation = entry.mutations.find((candidate) => candidate.registerKey === "config:portable" && candidate.kind === "config-snapshot");
    if (!mutation) throw new Error("config Outbox Mutation is missing");
    const configSync = recordValue(current.configSync, "config sync state");
    const publication = recordValue(configSync.publication, "config publication");
    if (publication.outboxId !== entry.id || publication.treeHash !== mutation.valueHash || !isRecord(publication.tree)) {
      throw new Error("config publication does not match its frozen Outbox");
    }

    const reconciles = parsePublishedReconciles(current.publishedReconciles);
    const reconcileIndex = reconciles.findIndex((candidate) => candidate.outboxId === entry.id && candidate.registerKey === "config:portable");
    if (reconcileIndex < 0 || reconciles[reconcileIndex].state !== "pending") {
      throw new Error("pending config PublishedReconcile was not found");
    }
    const projectLocal = publication.projectLocal === true;
    const localMatches = projectLocal && input.localTreeHash === publication.treeHash;
    reconciles[reconcileIndex] = { ...reconciles[reconcileIndex], state: localMatches ? "adopted" : "next-generation" };

    const nextConfig: Record<string, StateJsonValue> = { ...configSync, status: projectLocal ? (localMatches ? "ready" : "local-changes") : "local-changes" };
    delete nextConfig.publication;
    delete nextConfig.lastError;
    if (projectLocal) {
      const generation = Math.max(entry.captureGeneration, configSync.generation as number) + 1;
      nextConfig.projectedHeads = [mutation.versionId];
      nextConfig.projectedTreeHash = publication.treeHash;
      nextConfig.projectedTree = publication.tree;
      nextConfig.generation = generation;
      if (localMatches) delete nextConfig.dirtyIntent;
      else {
        nextConfig.dirtyIntent = {
          generation,
          basisHeads: [mutation.versionId],
          projectedTreeHash: publication.treeHash,
        };
      }
    }

    const merged: Record<string, StateJsonValue> = {
      ...current,
      configSync: nextConfig,
      publishedReconciles: toJson(reconciles),
    };
    validateRepositoryStatePayload(merged);
    return merged;
  });
}

export async function completePublishedVaultOutboxTransaction(
  store: DurableStateStore<StateJsonValue>,
  input: {
    outboxId: string;
    registerKey: string;
    projectionKey: string;
    localValueHash: string | null;
    syntheticEventId: string;
    dirtyIntent: StateJsonValue | null;
    vaultEvents: StateJsonValue;
    vaultGeneration: number;
  },
): Promise<DurableStateSnapshot<StateJsonValue>> {
  return store.update((current) => {
    if (!isRecord(current)) throw new Error("repository state is missing");
    validateRepositoryStatePayload(current);
    if ((input.localValueHash !== null && !isHash(input.localValueHash)) || input.syntheticEventId.length === 0
      || !Array.isArray(input.vaultEvents) || !Number.isSafeInteger(input.vaultGeneration) || input.vaultGeneration < 0) {
      throw new Error("Vault publication causal state is invalid");
    }
    const entry = parseDurableOutboxEntries(current.durableOutbox).find((candidate) => candidate.id === input.outboxId);
    const mutation = entry?.mutations.find((candidate) => candidate.registerKey === input.registerKey);
    if (!entry || entry.state !== "published" || !mutation || !mutation.registerKey.startsWith("vault:")) {
      throw new Error("Vault Outbox is not verified published");
    }
    const reconciles = parsePublishedReconciles(current.publishedReconciles);
    const reconcileIndex = reconciles.findIndex((candidate) => candidate.outboxId === entry.id && candidate.registerKey === input.registerKey);
    if (reconcileIndex < 0 || reconciles[reconcileIndex].state !== "pending") {
      throw new Error("pending Vault PublishedReconcile was not found");
    }
    const capturedDirtyGeneration = mutation.capturedDirtyGeneration ?? entry.captureGeneration;
    const capturedEventGeneration = mutation.capturedEventGeneration ?? entry.captureGeneration;
    const dirtyIntents = { ...recordOrEmpty(current.dirtyIntents) };
    const nextDirty = mergePublishedDirtyIntent(
      dirtyIntents[input.projectionKey],
      input.dirtyIntent,
      capturedDirtyGeneration,
      mutation.versionId,
      mutation.valueHash,
    );
    if (nextDirty === undefined) delete dirtyIntents[input.projectionKey];
    else dirtyIntents[input.projectionKey] = nextDirty;

    let vaultEvents = mergeVaultEventsAfterPublication(
      parseVaultEvents(current.vaultEvents),
      parseVaultEvents(input.vaultEvents),
      input.projectionKey,
      capturedEventGeneration,
      mutation.versionId,
    );
    let laterEvent = latestVaultEvent(vaultEvents, input.projectionKey);
    const localChanged = input.localValueHash !== mutation.valueHash;
    const currentVaultGeneration = numericMapValue(current.vaultGenerations, input.projectionKey);
    if (localChanged && nextDirty === undefined && laterEvent === undefined) {
      vaultEvents = recordVaultEvent(vaultEvents, {
        id: input.syntheticEventId,
        kind: input.localValueHash === null ? "delete" : "upsert",
        path: input.projectionKey,
        projectedHeads: [mutation.versionId],
        previousGeneration: Math.max(input.vaultGeneration, currentVaultGeneration, capturedEventGeneration),
      });
      vaultEvents = bindVaultEventsAfterPublication(
        vaultEvents,
        input.projectionKey,
        capturedEventGeneration,
        mutation.versionId,
      );
      laterEvent = latestVaultEvent(vaultEvents, input.projectionKey);
    }
    const reconcileState = !localChanged && nextDirty === undefined && laterEvent === undefined
      ? "adopted"
      : "next-generation";
    reconciles[reconcileIndex] = { ...reconciles[reconcileIndex], state: reconcileState };

    const projections = { ...recordOrEmpty(current.projections) };
    const currentProjection = isRecord(projections[input.projectionKey]) ? projections[input.projectionKey] : undefined;
    projections[input.projectionKey] = {
      projectedHeads: [mutation.versionId],
      projectedValueHash: mutation.valueHash,
      generation: Math.max(
        entry.captureGeneration,
        isRecord(currentProjection) && Number.isSafeInteger(currentProjection.generation)
          ? currentProjection.generation as number
          : 0,
      ),
    };
    const vaultGenerations = {
      ...recordOrEmpty(current.vaultGenerations),
      [input.projectionKey]: Math.max(
        input.vaultGeneration,
        currentVaultGeneration,
        laterEvent?.generation ?? 0,
      ),
    };
    const merged: Record<string, StateJsonValue> = {
      ...current,
      dirtyIntents,
      projections,
      publishedReconciles: toJson(reconciles),
      vaultEvents: toJson(vaultEvents),
      vaultGenerations,
    };
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
  validateConfigSyncState(value.configSync, identity);
  const entries = parseDurableOutboxEntries(value.durableOutbox);
  if (entries.some((entry) => entry.repositoryFingerprint !== identity.repositoryFingerprint)) {
    throw new Error("repository transaction Outbox belongs to another repository binding");
  }
  validateConfigPublicationOutbox(value.configSync, entries);
  return identity;
}

function validateConfigSyncState(
  value: StateJsonValue | undefined,
  identity: ReturnType<typeof parseRepositoryDurablePayload>,
): void {
  if (value === undefined) return;
  if (!isRecord(value) || !["unbound", "ready", "local-changes", "pending", "conflict", "incompatible",
    "apply-failed", "recovery-required", "load-failed"].includes(value.status as string)
    || !stringArray(value.projectedHeads) || !(value.projectedHeads as string[]).every(isVersionId)
    || (value.projectedTreeHash !== null && !isHash(value.projectedTreeHash))
    || !Number.isSafeInteger(value.generation) || (value.generation as number) < 0
    || typeof value.reloadRequired !== "boolean"
    || (value.lastError !== undefined && typeof value.lastError !== "string")
    || (value.recoveryLocation !== undefined && typeof value.recoveryLocation !== "string")) {
    throw new Error("repository transaction config sync state is invalid");
  }
  if (value.dirtyIntent !== undefined) validateConfigDirtyIntent(value.dirtyIntent);
  if (value.dirtyIntent !== undefined && isRecord(value.dirtyIntent)
    && value.dirtyIntent.projectedTreeHash !== value.projectedTreeHash) {
    throw new Error("repository transaction config dirty intent projection is invalid");
  }
  if ((value.projectedTreeHash === null) !== (value.projectedTree === undefined)) {
    throw new Error("repository transaction projected ConfigTree presence is invalid");
  }
  if (value.projectedTree !== undefined) {
    const treeHash = validatePersistedConfigTree(value.projectedTree, identity);
    if (treeHash !== value.projectedTreeHash) throw new Error("repository transaction projected ConfigTree hash is invalid");
  }
  if ((value.batchJournal === undefined) !== (value.batchTargetTree === undefined)) {
    throw new Error("repository transaction config batch recovery state is incomplete");
  }
  if (value.batchJournal !== undefined) validateConfigBatchJournal(value.batchJournal, identity);
  if (value.batchTargetTree !== undefined) {
    const targetHash = validatePersistedConfigTree(value.batchTargetTree, identity);
    if (isRecord(value.batchJournal) && isRecord(value.batchJournal.plan) && targetHash !== value.batchJournal.plan.targetTreeHash) {
      throw new Error("repository transaction config batch target Tree is invalid");
    }
  }
  if (value.publication !== undefined) {
    if (!isRecord(value.publication) || typeof value.publication.outboxId !== "string" || !isHash(value.publication.outboxId)
      || !isHash(value.publication.treeHash) || typeof value.publication.projectLocal !== "boolean"
      || !isRecord(value.publication.tree)) {
      throw new Error("repository transaction config publication is invalid");
    }
    const treeHash = validatePersistedConfigTree(value.publication.tree, identity);
    if (treeHash !== value.publication.treeHash) throw new Error("repository transaction config publication Tree hash is invalid");
  }
}

function validateConfigPublicationOutbox(value: StateJsonValue | undefined, entries: readonly DurableOutboxEntry[]): void {
  if (!isRecord(value) || value.publication === undefined) return;
  if (!isRecord(value.publication)) throw new Error("repository transaction config publication is invalid");
  const publication = value.publication;
  const entry = entries.find((candidate) => candidate.id === publication.outboxId);
  const mutation = entry?.mutations.find((candidate) => candidate.registerKey === "config:portable" && candidate.kind === "config-snapshot");
  if (!entry || !mutation || mutation.valueHash !== publication.treeHash) {
    throw new Error("repository transaction config publication has no matching Outbox");
  }
}

function validateConfigDirtyIntent(value: StateJsonValue): void {
  if (!isRecord(value) || !Number.isSafeInteger(value.generation) || (value.generation as number) <= 0
    || !stringArray(value.basisHeads) || !(value.basisHeads as string[]).every(isVersionId)
    || (value.projectedTreeHash !== null && !isHash(value.projectedTreeHash))) {
    throw new Error("repository transaction config dirty intent is invalid");
  }
}

function validatePersistedConfigTree(
  value: StateJsonValue,
  identity: ReturnType<typeof parseRepositoryDurablePayload>,
): string {
  if (!isRecord(value) || value.repositoryId !== identity.repositoryId || value.descriptorHash !== identity.descriptorHash
    || !Array.isArray(value.items)) throw new Error("repository transaction projected ConfigTree is invalid");
  const sizes = new Map<string, number>();
  for (const item of value.items) {
    if (!isRecord(item)) throw new Error("repository transaction projected ConfigTree item is invalid");
    if (item.kind === "put" && isHash(item.blobHash) && Number.isSafeInteger(item.size) && (item.size as number) >= 0) {
      sizes.set(item.blobHash as string, item.size as number);
    }
  }
  return buildConfigTreeObject("", value as unknown as ProtocolConfigTree, {
    configDir: identity.configDir,
    historicalConfigDirs: identity.historicalConfigDirs,
  }, sizes).hash;
}

function validateConfigBatchJournal(
  value: StateJsonValue,
  identity: ReturnType<typeof parseRepositoryDurablePayload>,
): void {
  if (!isRecord(value) || !isRecord(value.plan) || !isHash(value.planHash)
    || !["prepared", "snapshot-ready", "applying", "verifying", "rolling-back", "accounted", "recovery-required"].includes(value.state as string)
    || !Number.isSafeInteger(value.nextOperation) || (value.nextOperation as number) < 0
    || !isRecord(value.snapshotRefs) || !Array.isArray(value.displacedAfterRefs)
    || value.displacedAfterRefs.some((reference) => typeof reference !== "string")) {
    throw new Error("repository transaction config batch Journal is invalid");
  }
  const plan = value.plan as unknown as ConfigBatchPlan;
  validateConfigBatchPlan(plan, identity);
  if (configBatchPlanHash(plan) !== value.planHash || (value.nextOperation as number) > plan.operations.length) {
    throw new Error("repository transaction config batch Journal hash or progress is invalid");
  }
  for (const reference of Object.values(value.snapshotRefs)) {
    if (reference !== null && typeof reference !== "string") throw new Error("repository transaction config snapshot reference is invalid");
    if (typeof reference === "string") assertConfigStateReference(reference, identity.repositoryId);
  }
  for (const reference of value.displacedAfterRefs as string[]) assertConfigStateReference(reference, identity.repositoryId);
}

function validateConfigBatchPlan(plan: ConfigBatchPlan, identity: ReturnType<typeof parseRepositoryDurablePayload>): void {
  if (!plan || typeof plan.id !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(plan.id)
    || plan.repositoryFingerprint !== identity.repositoryFingerprint
    || !stringArray(plan.targetHeads as unknown as StateJsonValue) || !plan.targetHeads.every(isVersionId)
    || !stringArray(plan.projectedHeads as unknown as StateJsonValue) || !plan.projectedHeads.every(isVersionId)
    || (plan.projectedTreeHash !== null && !isHash(plan.projectedTreeHash)) || !isHash(plan.targetTreeHash)
    || !Array.isArray(plan.operations) || !Array.isArray(plan.diff) || !Array.isArray(plan.newPluginIds)
    || plan.newPluginIds.some((id) => typeof id !== "string")) {
    throw new Error("repository transaction config batch plan is invalid");
  }
  if (new Set(plan.targetHeads).size !== plan.targetHeads.length
    || new Set(plan.projectedHeads).size !== plan.projectedHeads.length
    || new Set(plan.operations.map((operation) => operation.path)).size !== plan.operations.length) {
    throw new Error("repository transaction config batch plan contains duplicates");
  }
  for (const operation of plan.operations) validateConfigBatchOperation(operation, identity.repositoryId);
}

function validateConfigBatchOperation(operation: ConfigBatchOperation, repositoryId: string): void {
  if (!operation || typeof operation.path !== "string" || !operation.expected || !operation.target
    || !["present", "absent"].includes(operation.expected.kind)
    || !["put", "delete", "stop-managing"].includes(operation.target.kind)) {
    throw new Error("repository transaction config batch operation is invalid");
  }
  try {
    if (normalizeVaultPath(operation.path) !== operation.path) throw new Error("not canonical");
  } catch {
    throw new Error("repository transaction config batch path is invalid");
  }
  if (operation.expected.kind === "present"
    && (!isHash(operation.expected.hash) || !Number.isSafeInteger(operation.expected.size) || operation.expected.size < 0)) {
    throw new Error("repository transaction config batch before-image is invalid");
  }
  if (operation.target.kind === "put") {
    if (!isHash(operation.target.hash) || !Number.isSafeInteger(operation.target.size) || operation.target.size < 0) {
      throw new Error("repository transaction config batch target is invalid");
    }
    assertConfigStateReference(operation.target.stagedRef, repositoryId);
  }
}

function assertConfigStateReference(reference: string, repositoryId: string): void {
  const prefix = `${LOCAL_STATE_CONTAINER}/${repositoryId}/`;
  if (!reference.startsWith(prefix)) throw new Error("repository transaction config state reference has another root");
  normalizeRepositoryStateReference(reference.slice(prefix.length));
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
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
        || (mutation.stagedContentRef !== undefined && typeof mutation.stagedContentRef !== "string")
        || (mutation.capturedDirtyGeneration !== undefined && (!Number.isSafeInteger(mutation.capturedDirtyGeneration) || (mutation.capturedDirtyGeneration as number) < 0))
        || (mutation.capturedEventGeneration !== undefined && (!Number.isSafeInteger(mutation.capturedEventGeneration) || (mutation.capturedEventGeneration as number) < 0))) {
        throw new Error("repository transaction durable Outbox Mutation is invalid");
      }
      if (mutation.stagedContentRef !== undefined) assertStateReference(mutation.stagedContentRef as string);
    }
    return raw as unknown as DurableOutboxEntry;
  });
  assertDurableOutboxQueue(entries);
  return entries;
}

function assertDurableOutboxEvolution(current: readonly DurableOutboxEntry[], next: readonly DurableOutboxEntry[]): void {
  const allowed: Record<DurableOutboxEntry["state"], DurableOutboxEntry["state"][]> = {
    queued: ["queued", "publishing", "recovery-required"],
    publishing: ["publishing", "published", "retryable-error", "integrity-error", "recovery-required"],
    published: ["published"],
    "retryable-error": ["retryable-error", "publishing", "recovery-required"],
    "integrity-error": ["integrity-error", "recovery-required"],
    "recovery-required": ["recovery-required"],
  };
  const nextById = new Map(next.map((entry) => [entry.id, entry]));
  for (const existing of current) {
    const candidate = nextById.get(existing.id);
    if (!candidate) throw new Error("repository transaction removed a durable Outbox entry");
    const immutableExisting = { ...existing, state: undefined };
    const immutableCandidate = { ...candidate, state: undefined };
    if (canonicalizeProtocolJson(toJson(immutableExisting)) !== canonicalizeProtocolJson(toJson(immutableCandidate))) {
      throw new Error("repository transaction rewrote a frozen durable Outbox entry");
    }
    if (!allowed[existing.state].includes(candidate.state)) throw new Error("repository transaction durable Outbox state regressed");
  }
}

function assertConfigPublicationEvolution(
  currentValue: StateJsonValue | undefined,
  nextValue: StateJsonValue | undefined,
  currentEntries: readonly DurableOutboxEntry[],
  nextEntries: readonly DurableOutboxEntry[],
): void {
  const current = isRecord(currentValue) && isRecord(currentValue.publication) ? currentValue.publication : undefined;
  const next = isRecord(nextValue) && isRecord(nextValue.publication) ? nextValue.publication : undefined;
  if (current && next && canonicalizeProtocolJson(current) !== canonicalizeProtocolJson(next)) {
    throw new Error("repository transaction rewrote a frozen config publication");
  }
  if (!current && next) {
    const outboxId = next.outboxId as string;
    if (currentEntries.some((entry) => entry.id === outboxId) || !nextEntries.some((entry) => entry.id === outboxId)) {
      throw new Error("repository transaction restored a completed config publication");
    }
  }
  if (current && !next) {
    const entry = nextEntries.find((candidate) => candidate.id === current.outboxId);
    if (!entry || entry.state !== "published") throw new Error("repository transaction dropped an unfinished config publication");
  }
}

function assertPublishedReconcileEvolution(
  current: ReturnType<typeof parsePublishedReconciles>,
  next: ReturnType<typeof parsePublishedReconciles>,
): void {
  const nextById = new Map(next.map((entry) => [`${entry.outboxId}:${entry.registerKey}:${entry.publishedVersionId}`, entry]));
  for (const existing of current) {
    const identity = `${existing.outboxId}:${existing.registerKey}:${existing.publishedVersionId}`;
    const candidate = nextById.get(identity);
    if (!candidate) throw new Error("repository transaction removed a PublishedReconcile");
    if (canonicalizeProtocolJson(toJson({ ...existing, state: undefined }))
      !== canonicalizeProtocolJson(toJson({ ...candidate, state: undefined }))) {
      throw new Error("repository transaction rewrote a PublishedReconcile");
    }
    if (existing.state !== candidate.state && existing.state !== "pending") {
      throw new Error("repository transaction PublishedReconcile state regressed");
    }
  }
}

function mergePublishedDirtyIntent(
  current: StateJsonValue | undefined,
  observed: StateJsonValue | null,
  capturedGeneration: number,
  localPredecessorVersion: string,
  projectedValueHash: string | null,
): StateJsonValue | undefined {
  const currentRecord = isRecord(current) ? current : undefined;
  const observedRecord = observed === null ? undefined : isRecord(observed) ? observed : undefined;
  if (observed !== null && !observedRecord) throw new Error("Vault publication dirty intent is invalid");
  const currentGeneration = stateGeneration(currentRecord);
  const observedGeneration = stateGeneration(observedRecord);
  if (Math.max(currentGeneration, observedGeneration) <= capturedGeneration) return undefined;

  const newer = observedGeneration >= currentGeneration ? observedRecord : currentRecord;
  const older = newer === observedRecord ? currentRecord : observedRecord;
  const merged: Record<string, StateJsonValue> = { ...(older ?? {}), ...(newer ?? {}) };
  for (const key of ["localCandidates", "editorContents"] as const) {
    const values = mergeStateArrays(older?.[key], newer?.[key]);
    if (values) merged[key] = values;
  }
  if (older?.awaitingLocalWrite === false || newer?.awaitingLocalWrite === false) merged.awaitingLocalWrite = false;
  merged.basisHeads = [];
  merged.localPredecessorVersion = localPredecessorVersion;
  if (projectedValueHash === null) delete merged.projectedValueHash;
  else merged.projectedValueHash = projectedValueHash;
  return merged;
}

function mergeStateArrays(left: StateJsonValue | undefined, right: StateJsonValue | undefined): StateJsonValue[] | undefined {
  if (!Array.isArray(left) && !Array.isArray(right)) return undefined;
  const merged = new Map<string, StateJsonValue>();
  for (const value of [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]) {
    merged.set(canonicalizeProtocolJson(value), value);
  }
  return [...merged.values()];
}

function stateGeneration(value: Record<string, StateJsonValue> | undefined): number {
  return value && Number.isSafeInteger(value.generation) && (value.generation as number) >= 0
    ? value.generation as number
    : 0;
}

function parseVaultEvents(value: StateJsonValue | undefined): VaultEventIntent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("repository transaction Vault events are invalid");
  const ids = new Set<string>();
  return value.map((raw) => {
    if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length === 0 || ids.has(raw.id)
      || !["upsert", "delete"].includes(raw.kind as string) || typeof raw.path !== "string"
      || !Number.isSafeInteger(raw.generation) || (raw.generation as number) <= 0
      || !stringArray(raw.basisHeads)
      || (raw.transactionId !== undefined && typeof raw.transactionId !== "string")
      || (raw.localPredecessorVersion !== undefined && typeof raw.localPredecessorVersion !== "string")) {
      throw new Error("repository transaction Vault event is invalid");
    }
    const path = normalizeVaultPath(raw.path as string);
    if (path !== raw.path) throw new Error("repository transaction Vault event path is not normalized");
    ids.add(raw.id as string);
    return {
      id: raw.id as string,
      ...(raw.transactionId === undefined ? {} : { transactionId: raw.transactionId as string }),
      kind: raw.kind as VaultEventIntent["kind"],
      path,
      generation: raw.generation as number,
      basisHeads: [...raw.basisHeads as string[]],
      ...(raw.localPredecessorVersion === undefined
        ? {}
        : { localPredecessorVersion: raw.localPredecessorVersion as string }),
    };
  });
}

function numericMapValue(value: StateJsonValue | undefined, key: string): number {
  const candidate = isRecord(value) ? value[key] : undefined;
  return Number.isSafeInteger(candidate) && (candidate as number) >= 0 ? candidate as number : 0;
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
