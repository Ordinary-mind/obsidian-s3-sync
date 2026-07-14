import type { WriterFrontiers } from "./commit-frontier";
import { canonicalizeProtocolJson } from "../protocol/json";
import { sha256Hex } from "../protocol/hash";

export interface RepositoryCheckpoint {
  schemaVersion: 1;
  repositoryId: string;
  descriptorHash: string;
  writerFrontiers: WriterFrontiers;
  stateHash: string;
  createdAt: number;
}

export interface CheckpointRegisterState {
  key: string;
  heads: string[];
  pending: string[];
  invalid: string[];
  valueHash?: string | null;
}

export interface CheckpointStateRoot {
  schemaVersion: 1;
  repositoryId: string;
  descriptorHash: string;
  writerFrontiers: WriterFrontiers;
  registers: CheckpointRegisterState[];
}

export interface CheckpointVerification {
  verifyDescriptor(repositoryId: string, descriptorHash: string): Promise<void>;
  verifyWriterFrontiers(repositoryId: string, descriptorHash: string, frontiers: WriterFrontiers): Promise<void>;
  verifyStateHash(checkpoint: RepositoryCheckpoint): Promise<boolean>;
}

export async function verifyCheckpointBeforeUse(
  checkpoint: RepositoryCheckpoint,
  verification: CheckpointVerification,
): Promise<"usable" | "full-history-required"> {
  try {
    await verification.verifyDescriptor(checkpoint.repositoryId, checkpoint.descriptorHash);
    await verification.verifyWriterFrontiers(checkpoint.repositoryId, checkpoint.descriptorHash, checkpoint.writerFrontiers);
    if (!(await verification.verifyStateHash(checkpoint))) return "full-history-required";
    return "usable";
  } catch {
    return "full-history-required";
  }
}

export function checkpointStateHash(root: CheckpointStateRoot): string {
  return sha256Hex(new TextEncoder().encode(canonicalizeProtocolJson(normalizeStateRoot(root))));
}

export function createRepositoryCheckpoint(root: CheckpointStateRoot, createdAt: number): RepositoryCheckpoint {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error("checkpoint creation time is invalid");
  const normalized = normalizeStateRoot(root);
  return {
    schemaVersion: 1,
    repositoryId: normalized.repositoryId,
    descriptorHash: normalized.descriptorHash,
    writerFrontiers: structuredClone(normalized.writerFrontiers),
    stateHash: checkpointStateHash(normalized),
    createdAt,
  };
}

export function checkpointMatchesStateRoot(
  checkpoint: RepositoryCheckpoint,
  root: CheckpointStateRoot,
): boolean {
  try {
    const normalized = normalizeStateRoot(root);
    return checkpoint.schemaVersion === 1
      && checkpoint.repositoryId === normalized.repositoryId
      && checkpoint.descriptorHash === normalized.descriptorHash
      && canonicalizeProtocolJson(checkpoint.writerFrontiers) === canonicalizeProtocolJson(normalized.writerFrontiers)
      && checkpoint.stateHash === checkpointStateHash(normalized);
  } catch {
    return false;
  }
}

export const checkpointHistoryPolicy = Object.freeze({
  newClient: "full-history",
  verificationFailure: "full-history",
  verifiedCheckpoint: "checkpoint-and-verified-frontiers",
} as const);

export const correctnessNeutralRemoteCaches = ["checkpoint", "latest", "device-head"] as const;

function normalizeStateRoot(root: CheckpointStateRoot): CheckpointStateRoot {
  if (root.schemaVersion !== 1) throw new Error("checkpoint state root schema is invalid");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(root.repositoryId)) {
    throw new Error("checkpoint repositoryId is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(root.descriptorHash)) throw new Error("checkpoint descriptor Hash is invalid");
  const registerKeys = new Set<string>();
  const registers = root.registers.map((register) => {
    if (!register.key || registerKeys.has(register.key)) throw new Error("checkpoint register keys must be non-empty and unique");
    registerKeys.add(register.key);
    if (register.valueHash !== undefined && register.valueHash !== null && !/^[0-9a-f]{64}$/.test(register.valueHash)) {
      throw new Error("checkpoint register value Hash is invalid");
    }
    return {
      key: register.key,
      heads: sortedUnique(register.heads, "heads"),
      pending: sortedUnique(register.pending, "pending"),
      invalid: sortedUnique(register.invalid, "invalid"),
      ...(register.valueHash !== undefined ? { valueHash: register.valueHash } : {}),
    };
  }).sort((left, right) => compareUtf8(left.key, right.key));
  const writerFrontiers = Object.fromEntries(Object.entries(root.writerFrontiers)
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([writerId, anchors]) => [writerId, [...anchors]
      .map((anchor) => ({ ...anchor }))
      .sort((left, right) => compareUtf8(left.key, right.key))]));
  return {
    schemaVersion: 1,
    repositoryId: root.repositoryId,
    descriptorHash: root.descriptorHash,
    writerFrontiers,
    registers,
  };
}

function sortedUnique(values: readonly string[], label: string): string[] {
  if (values.some((value) => typeof value !== "string" || value.length === 0)) throw new Error(`checkpoint ${label} are invalid`);
  if (new Set(values).size !== values.length) throw new Error(`checkpoint ${label} contain duplicates`);
  return [...values].sort(compareUtf8);
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return a.length - b.length;
}
