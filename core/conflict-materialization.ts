import { canonicalizeProtocolJson } from "../protocol/json";
import { conflictId } from "./conflict-id";
import { conflictMetadataPath, conflictVersionCopyPath } from "./conflict-copy";

export type ConflictCandidate =
  | { kind: "put"; logicalPath: string; versionId: string; blobHash: string; size: number; stagedRef: string; writerId?: string }
  | { kind: "delete"; logicalPath: string; versionId: string; writerId?: string };

export interface ConflictMaterializationPlan {
  conflictId: string;
  directory: string;
  logicalKeys: string[];
  heads: string[];
  bodies: Array<{ versionId: string; stagedRef: string; destination: string; blobHash: string; size: number }>;
  metadataPath: string;
  metadataBytes: Uint8Array;
}

export interface ConflictMaterializationAdapter {
  ensureOwnedConflictRoot(): Promise<void>;
  ensureDirectory(path: string): Promise<void>;
  installBodyNoClobber(stagedRef: string, destination: string, expectedHash: string, expectedSize: number): Promise<"installed" | "already-identical">;
  writeMetadataCanonical(path: string, bytes: Uint8Array): Promise<void>;
}

export interface ConflictDraft {
  conflictId: string;
  logicalKeys: string[];
  contentRef: string;
  hash: string;
  size: number;
  state: "editing" | "frozen-for-resolution" | "published";
}

export function buildConflictMaterializationPlan(input: {
  repositoryId: string;
  channel: "vault" | "config";
  logicalKeys: readonly string[];
  candidates: readonly ConflictCandidate[];
}): ConflictMaterializationPlan {
  const logicalKeys = sortUnique(input.logicalKeys);
  const candidates = [...input.candidates].sort((left, right) => compareUtf8(left.versionId, right.versionId));
  if (logicalKeys.length === 0 || candidates.length === 0) throw new Error("conflict materialization requires keys and candidates");
  const heads = candidates.map((candidate) => candidate.versionId);
  if (new Set(heads).size !== heads.length) throw new Error("conflict materialization contains duplicate Version IDs");
  if (candidates.some((candidate) => !logicalKeys.includes(candidate.logicalPath))) throw new Error("conflict candidate is outside logical keys");
  const id = conflictId(input.repositoryId, input.channel, logicalKeys, heads);
  const directory = `.s3-sync-conflicts/${id}`;
  const bodies = candidates.flatMap((candidate) => candidate.kind === "put" ? [{
    versionId: candidate.versionId,
    stagedRef: candidate.stagedRef,
    destination: conflictVersionCopyPath(id, candidate.versionId),
    blobHash: candidate.blobHash,
    size: candidate.size,
  }] : []);
  const metadata = {
    schemaVersion: 1,
    repositoryId: input.repositoryId,
    channel: input.channel,
    conflictId: id,
    logicalKeys,
    heads,
    candidates: candidates.map((candidate) => candidate.kind === "put" ? {
      kind: "put",
      logicalPath: candidate.logicalPath,
      versionId: candidate.versionId,
      blobHash: candidate.blobHash,
      size: candidate.size,
      bodyFile: conflictVersionCopyPath(id, candidate.versionId).slice(directory.length + 1),
      ...(candidate.writerId ? { writerId: candidate.writerId } : {}),
    } : {
      kind: "delete",
      logicalPath: candidate.logicalPath,
      versionId: candidate.versionId,
      ...(candidate.writerId ? { writerId: candidate.writerId } : {}),
    }),
  };
  return {
    conflictId: id,
    directory,
    logicalKeys,
    heads,
    bodies,
    metadataPath: conflictMetadataPath(id),
    metadataBytes: new TextEncoder().encode(canonicalizeProtocolJson(metadata)),
  };
}

export async function materializeConflict(plan: ConflictMaterializationPlan, adapter: ConflictMaterializationAdapter): Promise<void> {
  await adapter.ensureOwnedConflictRoot();
  await adapter.ensureDirectory(plan.directory);
  for (const body of plan.bodies) {
    await adapter.installBodyNoClobber(body.stagedRef, body.destination, body.blobHash, body.size);
  }
  await adapter.writeMetadataCanonical(plan.metadataPath, new Uint8Array(plan.metadataBytes));
}

export function planConflictDraftMigration(
  draft: ConflictDraft,
  nextConflictId: string,
  nextLogicalKeys: readonly string[],
): ConflictDraft {
  if (draft.state === "published") throw new Error("published conflict draft cannot migrate");
  if (!/^[0-9a-f]{64}$/.test(nextConflictId)) throw new Error("next conflict ID is invalid");
  return { ...draft, conflictId: nextConflictId, logicalKeys: sortUnique(nextLogicalKeys) };
}

export function mayPublishOrdinaryConflictPath(draft: ConflictDraft | undefined, conflictActive: boolean): boolean {
  return !conflictActive && draft === undefined;
}

export function mayCleanConflictMaterialization(input: {
  resolutionObserved: boolean;
  hasUnpublishedDraft: boolean;
  hasRecoveryReference: boolean;
}): boolean {
  return input.resolutionObserved && !input.hasUnpublishedDraft && !input.hasRecoveryReference;
}

function sortUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareUtf8);
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}
