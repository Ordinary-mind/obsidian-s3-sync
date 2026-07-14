import { canonicalizeProtocolJson } from "../protocol/json";
import { isWithinBlobLimit } from "../protocol/limits";
import { conflictId, conflictLogicalKey } from "./conflict-id";
import { conflictMetadataPath, conflictVersionCopyPath } from "./conflict-copy";
import { normalizeRepositoryStateReference } from "./local-state-layout";

export type ConflictCandidate =
  | { kind: "put"; logicalPath: string; versionId: string; blobHash: string; size: number; stagedRef: string; writerId?: string }
  | { kind: "delete"; logicalPath: string; versionId: string; writerId?: string };

export interface ConflictMaterializationPlan {
  conflictId: string;
  directory: string;
  logicalKeys: string[];
  logicalPaths: string[];
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
  const logicalPaths = sortUnique(input.logicalKeys.map((path) => conflictLogicalKey(input.channel, path).slice(`${input.channel}:`.length)));
  const logicalKeys = logicalPaths.map((path) => conflictLogicalKey(input.channel, path));
  const candidates = input.candidates
    .map((candidate) => normalizeCandidate(input.channel, candidate))
    .sort((left, right) => compareUtf8(left.versionId, right.versionId));
  if (logicalPaths.length === 0 || candidates.length === 0) throw new Error("conflict materialization requires keys and candidates");
  const heads = candidates.map((candidate) => candidate.versionId);
  if (new Set(heads).size !== heads.length) throw new Error("conflict materialization contains duplicate Version IDs");
  if (candidates.some((candidate) => !logicalPaths.includes(candidate.logicalPath))) throw new Error("conflict candidate is outside logical keys");
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
    logicalPaths,
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
  return { ...draft, conflictId: nextConflictId, logicalKeys: canonicalDraftLogicalKeys(nextLogicalKeys), state: "editing" };
}

export function createConflictDraft(input: {
  conflictId: string;
  logicalKeys: readonly string[];
  contentRef: string;
  hash: string;
  size: number;
}): ConflictDraft {
  if (!/^[0-9a-f]{64}$/.test(input.conflictId) || !/^[0-9a-f]{64}$/.test(input.hash)) {
    throw new Error("conflict draft identity is invalid");
  }
  if (!Number.isSafeInteger(input.size) || input.size < 0) throw new Error("conflict draft size is invalid");
  const contentRef = normalizeRepositoryStateReference(input.contentRef, ["conflict-drafts"]);
  const logicalKeys = canonicalDraftLogicalKeys(input.logicalKeys);
  return {
    conflictId: input.conflictId,
    logicalKeys,
    contentRef,
    hash: input.hash,
    size: input.size,
    state: "editing",
  };
}

export function freezeConflictDraftForResolution(
  draft: ConflictDraft,
  current: Pick<ConflictDraft, "contentRef" | "hash" | "size">,
): ConflictDraft {
  if (draft.state !== "editing") throw new Error("conflict draft is not editable");
  if (draft.contentRef !== current.contentRef || draft.hash !== current.hash || draft.size !== current.size) {
    throw new Error("conflict draft changed; refresh resolution preview");
  }
  return { ...draft, logicalKeys: [...draft.logicalKeys], state: "frozen-for-resolution" };
}

export function markConflictDraftPublished(draft: ConflictDraft): ConflictDraft {
  if (draft.state !== "frozen-for-resolution") throw new Error("conflict draft is not frozen for resolution");
  return { ...draft, logicalKeys: [...draft.logicalKeys], state: "published" };
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

function canonicalDraftLogicalKeys(values: readonly string[]): string[] {
  const logicalKeys = sortUnique(values);
  if (logicalKeys.length === 0) throw new Error("conflict draft logical keys are invalid");
  for (const key of logicalKeys) {
    if (key === "config:portable") continue;
    if (!key.startsWith("vault:") || conflictLogicalKey("vault", key.slice("vault:".length)) !== key) {
      throw new Error("conflict draft logical keys are invalid");
    }
  }
  return logicalKeys;
}

function normalizeCandidate(channel: "vault" | "config", candidate: ConflictCandidate): ConflictCandidate {
  const logicalPath = conflictLogicalKey(channel, candidate.logicalPath).slice(`${channel}:`.length);
  if (candidate.kind === "delete") return { ...candidate, logicalPath };
  if (!/^[0-9a-f]{64}$/.test(candidate.blobHash)) throw new Error("conflict candidate Blob Hash is invalid");
  if (!isWithinBlobLimit(candidate.size)) throw new Error("conflict candidate Blob size is invalid");
  return {
    ...candidate,
    logicalPath,
    stagedRef: normalizeRepositoryStateReference(candidate.stagedRef, ["staged"]),
  };
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
