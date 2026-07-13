import { sha256Hex } from "../protocol/hash";
import { canonicalizeProtocolJson } from "../protocol/json";
import { changeChunkKey, commitKey } from "../protocol/keys";
import { parseAndValidateBoundCommitEnvelope } from "../protocol/validation";
import type { ImmutableObject } from "./immutable-object";
import type { CommitKind } from "./types";

export interface ConfigSnapshotEnvelopeInput {
  prefix: string;
  repositoryId: string;
  descriptorHash: string;
  writerId: string;
  sequence: string;
  previousCommitHash: string | null;
  createdAt: string;
  clientVersion: string;
  kind: CommitKind;
  treeHash: string;
  parents: string[];
}

export function buildConfigSnapshotEnvelope(input: ConfigSnapshotEnvelopeInput): {
  chunk: ImmutableObject;
  commit: ImmutableObject;
} {
  const parents = [...new Set(input.parents)].sort(compareUtf8);
  const chunkBody = {
    protocol: 1,
    repositoryId: input.repositoryId,
    descriptorHash: input.descriptorHash,
    channel: "config",
    chunkIndex: 0,
    chunkCount: 1,
    mutations: [{ key: "portable", kind: "snapshot", treeHash: input.treeHash, parents }],
  };
  const chunkBytes = new TextEncoder().encode(canonicalizeProtocolJson(chunkBody));
  const chunkHash = sha256Hex(chunkBytes);
  const commitBody = {
    protocol: 1,
    repositoryId: input.repositoryId,
    descriptorHash: input.descriptorHash,
    writerId: input.writerId,
    sequence: input.sequence,
    previousCommitHash: input.previousCommitHash,
    createdAt: input.createdAt,
    channel: "config",
    kind: input.kind,
    changeChunkHashes: [chunkHash],
    clientVersion: input.clientVersion,
  };
  const commitBytes = new TextEncoder().encode(canonicalizeProtocolJson(commitBody));
  const commitHash = sha256Hex(commitBytes);
  parseAndValidateBoundCommitEnvelope(input.repositoryId, input.descriptorHash, commitBytes, [chunkBytes]);
  return {
    chunk: { key: changeChunkKey(input.prefix, input.repositoryId, chunkHash), hash: chunkHash, bytes: chunkBytes },
    commit: { key: commitKey(input.prefix, input.repositoryId, input.writerId, input.sequence, commitHash), hash: commitHash, bytes: commitBytes },
  };
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder(); const a = encoder.encode(left); const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return a.length - b.length;
}
