import { canonicalizeProtocolJson } from "../protocol/json";
import { sha256Hex } from "../protocol/hash";
import { changeChunkKey, commitKey } from "../protocol/keys";
import { parseAndValidateBoundCommitEnvelope } from "../protocol/validation";
import type { ImmutableObject } from "./immutable-object";
import type { CommitKind, VaultMutation } from "./types";

const encoder = new TextEncoder();

export interface VaultChangeEnvelopeInput {
  prefix: string;
  repositoryId: string;
  descriptorHash: string;
  writerId: string;
  sequence: string;
  previousCommitHash: string | null;
  createdAt: string;
  kind: CommitKind;
  clientVersion: string;
  mutations: VaultMutation[];
}

export function buildVaultChangeEnvelope(input: VaultChangeEnvelopeInput): { chunk: ImmutableObject; commit: ImmutableObject } {
  const envelope = buildVaultMultiChunkEnvelope(input);
  if (envelope.chunks.length !== 1) throw new Error("single-Chunk builder received more than 4,096 mutations");
  return { chunk: envelope.chunks[0], commit: envelope.commit };
}

export function buildVaultMultiChunkEnvelope(
  input: VaultChangeEnvelopeInput,
  chunkMutationLimit = 4096,
): { chunks: ImmutableObject[]; commit: ImmutableObject } {
  if (!Number.isSafeInteger(chunkMutationLimit) || chunkMutationLimit < 1 || chunkMutationLimit > 4096) {
    throw new Error("invalid Change Chunk mutation limit");
  }
  if (input.mutations.length === 0) throw new Error("Commit requires at least one Mutation");
  const mutations = input.mutations.map(copyMutation).sort((left, right) => compareUtf8(left.path, right.path));
  if (new Set(mutations.map((mutation) => mutation.path)).size !== mutations.length) {
    throw new Error("Commit contains a duplicate Vault path");
  }
  const chunkCount = Math.ceil(mutations.length / chunkMutationLimit);
  if (chunkCount > 1024) throw new Error("Commit exceeds 1,024 Change Chunks");
  const chunkBytes = Array.from({ length: chunkCount }, (_, chunkIndex) => {
    const chunkMutations = mutations.slice(chunkIndex * chunkMutationLimit, (chunkIndex + 1) * chunkMutationLimit);
    const chunkObject = {
      protocol: 1,
      repositoryId: input.repositoryId,
      descriptorHash: input.descriptorHash,
      channel: "vault",
      chunkIndex,
      chunkCount,
      mutations: chunkMutations.map((mutation) => mutation.kind === "put"
        ? { path: mutation.path, kind: "put", blobHash: mutation.blob?.hash, size: mutation.blob?.size, parents: mutation.parents }
        : { path: mutation.path, kind: "delete", parents: mutation.parents }),
    };
    return encoder.encode(canonicalizeProtocolJson(chunkObject));
  });
  const chunkHashes = chunkBytes.map(sha256Hex);
  const commitObject = {
    protocol: 1,
    repositoryId: input.repositoryId,
    descriptorHash: input.descriptorHash,
    writerId: input.writerId,
    sequence: input.sequence,
    previousCommitHash: input.previousCommitHash,
    createdAt: input.createdAt,
    channel: "vault",
    kind: input.kind,
    changeChunkHashes: chunkHashes,
    clientVersion: input.clientVersion,
  };
  const commitBytes = encoder.encode(canonicalizeProtocolJson(commitObject));
  const commitHash = sha256Hex(commitBytes);
  parseAndValidateBoundCommitEnvelope(input.repositoryId, input.descriptorHash, commitBytes, chunkBytes);
  return {
    chunks: chunkBytes.map((bytes, index) => ({
      key: changeChunkKey(input.prefix, input.repositoryId, chunkHashes[index]),
      hash: chunkHashes[index],
      bytes,
    })),
    commit: {
      key: commitKey(input.prefix, input.repositoryId, input.writerId, input.sequence, commitHash),
      hash: commitHash,
      bytes: commitBytes,
    },
  };
}

function copyMutation(mutation: VaultMutation): VaultMutation {
  return {
    ...mutation,
    parents: [...mutation.parents].sort(compareUtf8),
    ...(mutation.blob ? { blob: { ...mutation.blob } } : {}),
  };
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}
