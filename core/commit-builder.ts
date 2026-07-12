import { canonicalizeProtocolJson } from "../protocol/json";
import { sha256Hex } from "../protocol/hash";
import { changeChunkKey, commitKey } from "../protocol/keys";
import { parseAndValidateBoundCommitEnvelope } from "../protocol/validation";
import type { ImmutableObject } from "./immutable-object";
import type { CommitKind, VaultMutation } from "./types";

const encoder = new TextEncoder();

export function buildVaultChangeEnvelope(input: { prefix: string; repositoryId: string; descriptorHash: string; writerId: string; sequence: string; previousCommitHash: string | null; createdAt: string; kind: CommitKind; clientVersion: string; mutations: VaultMutation[] }): { chunk: ImmutableObject; commit: ImmutableObject } {
  const chunkObject = { protocol: 1, repositoryId: input.repositoryId, descriptorHash: input.descriptorHash, channel: "vault", chunkIndex: 0, chunkCount: 1, mutations: input.mutations.map((mutation) => mutation.kind === "put" ? { path: mutation.path, kind: "put", blobHash: mutation.blob?.hash, size: mutation.blob?.size, parents: mutation.parents } : { path: mutation.path, kind: "delete", parents: mutation.parents }) };
  const chunkBytes = encoder.encode(canonicalizeProtocolJson(chunkObject));
  const chunkHash = sha256Hex(chunkBytes);
  const commitObject = { protocol: 1, repositoryId: input.repositoryId, descriptorHash: input.descriptorHash, writerId: input.writerId, sequence: input.sequence, previousCommitHash: input.previousCommitHash, createdAt: input.createdAt, channel: "vault", kind: input.kind, changeChunkHashes: [chunkHash], clientVersion: input.clientVersion };
  const commitBytes = encoder.encode(canonicalizeProtocolJson(commitObject));
  const commitHash = sha256Hex(commitBytes);
  parseAndValidateBoundCommitEnvelope(input.repositoryId, input.descriptorHash, commitBytes, [chunkBytes]);
  return { chunk: { key: changeChunkKey(input.prefix, input.repositoryId, chunkHash), hash: chunkHash, bytes: chunkBytes }, commit: { key: commitKey(input.prefix, input.repositoryId, input.writerId, input.sequence, commitHash), hash: commitHash, bytes: commitBytes } };
}
