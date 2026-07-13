import type { DurableStateSnapshot, DurableStateStore, StateJsonValue } from "./durable-state";
import { parseRepositoryDurablePayload } from "./repository-durable-payload";

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

export function validateRepositoryStatePayload(value: StateJsonValue): ReturnType<typeof parseRepositoryDurablePayload> {
  if (!isRecord(value)) throw new Error("repository transaction payload must be an object");
  const identity = parseRepositoryDurablePayload(value);
  validateRecordMap(value.dirtyIntents, "dirtyIntents");
  validateProjections(value.projections);
  validateOutboxReferences(value.outboxRefs);
  validateSparseSeenCommits(value.sparseSeenCommits);
  validateObservedRegisters(value.observedRegisters);
  validatePendingApply(value.pendingApply);
  return identity;
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

function validateRecordMap(value: StateJsonValue | undefined, name: string): void {
  if (!isRecord(value)) throw new Error(`repository transaction ${name} is invalid`);
}

function stringArray(value: StateJsonValue | undefined): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: StateJsonValue | undefined): value is Record<string, StateJsonValue> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
