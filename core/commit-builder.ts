import { canonicalizeProtocolJson } from "../protocol/json";
import { sha256Hex } from "../protocol/hash";
import { changeChunkKey, commitKey } from "../protocol/keys";
import { IncrementalCommitEnvelopeValidator, parseAndValidateBoundCommitEnvelope, parseAndValidateProtocolObject } from "../protocol/validation";
import { protocolLimits } from "../protocol/limits";
import type { ProtocolCommit } from "../protocol/semantics";
import type { ImmutableObject } from "./immutable-object";
import type { CommitKind, VaultMutation } from "./types";
import { compareUtf8 } from "../protocol/utf8";

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

export type IncrementalBuildPhase = "copy" | "sort" | "partition" | "encode" | "parse" | "validate";

export function buildVaultChangeEnvelope(input: VaultChangeEnvelopeInput): { chunk: ImmutableObject; commit: ImmutableObject } {
  const envelope = buildVaultMultiChunkEnvelope(input);
  if (envelope.chunks.length !== 1) throw new Error("single-Chunk builder input requires multiple bounded Change Chunks");
  return { chunk: envelope.chunks[0], commit: envelope.commit };
}

export function buildVaultMultiChunkEnvelope(
  input: VaultChangeEnvelopeInput,
  chunkMutationLimit: number = protocolLimits.chunkMutations,
): { chunks: ImmutableObject[]; commit: ImmutableObject } {
  assertBuildInput(input, chunkMutationLimit);
  const mutations = input.mutations.map(copyMutation).sort((left, right) => compareUtf8(left.path, right.path));
  assertNoDuplicatePaths(mutations);
  return buildFromSortedMutations(input, mutations, chunkMutationLimit);
}

export async function buildVaultMultiChunkEnvelopeIncremental(
  input: VaultChangeEnvelopeInput,
  options: {
    chunkMutationLimit?: number;
    workSlice?: number;
    yieldToIdle?: (phase?: IncrementalBuildPhase) => Promise<void>;
  } = {},
): Promise<{ chunks: ImmutableObject[]; commit: ImmutableObject }> {
  const chunkMutationLimit = options.chunkMutationLimit ?? protocolLimits.chunkMutations;
  const workSlice = options.workSlice ?? 1024;
  assertBuildInput(input, chunkMutationLimit);
  if (!Number.isSafeInteger(workSlice) || workSlice < 1) throw new Error("incremental builder work slice is invalid");
  const mutations = await copyAndSortMutationsIncrementally(
    input.mutations,
    workSlice,
    options.yieldToIdle ?? defaultYieldToIdle,
  );
  assertNoDuplicatePaths(mutations);
  await (options.yieldToIdle ?? defaultYieldToIdle)("sort");
  return buildFromSortedMutationsIncrementally(
    input,
    mutations,
    chunkMutationLimit,
    options.yieldToIdle ?? defaultYieldToIdle,
  );
}

function buildFromSortedMutations(
  input: VaultChangeEnvelopeInput,
  mutations: VaultMutation[],
  chunkMutationLimit: number,
): { chunks: ImmutableObject[]; commit: ImmutableObject } {
  const mutationGroups = initialMutationGroups(mutations, chunkMutationLimit)
    .flatMap((group) => splitToByteBound(input, group));
  const chunkCount = mutationGroups.length;
  if (chunkCount > protocolLimits.commitChunks) throw new Error("Commit exceeds 1,024 Change Chunks");
  const chunkBytes = mutationGroups.map((chunkMutations, chunkIndex) => encodeChunk(
    input,
    chunkMutations,
    chunkIndex,
    chunkCount,
  ));
  if (chunkBytes.some((bytes) => bytes.byteLength > protocolLimits.changeChunkBytes)) {
    throw new Error("Change Chunk exceeds its frozen byte limit");
  }
  const encoded = encodeCommit(input, chunkBytes);
  parseAndValidateBoundCommitEnvelope(input.repositoryId, input.descriptorHash, encoded.commitBytes, chunkBytes);
  return assembleEnvelope(input, chunkBytes, encoded);
}

async function buildFromSortedMutationsIncrementally(
  input: VaultChangeEnvelopeInput,
  mutations: VaultMutation[],
  chunkMutationLimit: number,
  yieldToIdle: (phase?: IncrementalBuildPhase) => Promise<void>,
): Promise<{ chunks: ImmutableObject[]; commit: ImmutableObject }> {
  const mutationGroups: VaultMutation[][] = [];
  for (const group of initialMutationGroups(mutations, chunkMutationLimit)) {
    mutationGroups.push(...splitToByteBound(input, group));
    await yieldToIdle("partition");
  }
  if (mutationGroups.length > protocolLimits.commitChunks) throw new Error("Commit exceeds 1,024 Change Chunks");
  mutations.length = 0;
  await yieldToIdle("partition");
  const chunkBytes: Uint8Array[] = [];
  for (let index = 0; index < mutationGroups.length; index += 1) {
    const bytes = encodeChunk(input, mutationGroups[index], index, mutationGroups.length);
    if (bytes.byteLength > protocolLimits.changeChunkBytes) throw new Error("Change Chunk exceeds its frozen byte limit");
    chunkBytes.push(bytes);
    mutationGroups[index].length = 0;
    await yieldToIdle("encode");
  }
  mutationGroups.length = 0;
  await yieldToIdle("encode");
  const encoded = encodeCommit(input, chunkBytes);
  const commit = parseAndValidateProtocolObject("commit", encoded.commitBytes) as unknown as ProtocolCommit;
  const key = commitKey(input.prefix, input.repositoryId, input.writerId, input.sequence, encoded.commitHash);
  const validator = new IncrementalCommitEnvelopeValidator(
    input.repositoryId,
    input.descriptorHash,
    commit,
    key,
    encoded.commitHash,
  );
  for (let index = 0; index < chunkBytes.length; index += 1) {
    await validator.acceptChunkIncrementally(
      index,
      changeChunkKey(input.prefix, input.repositoryId, encoded.chunkHashes[index]),
      chunkBytes[index],
      (phase) => yieldToIdle(phase),
    );
  }
  validator.finish();
  return assembleEnvelope(input, chunkBytes, encoded);
}

function encodeCommit(
  input: VaultChangeEnvelopeInput,
  chunkBytes: readonly Uint8Array[],
): { chunkHashes: string[]; commitBytes: Uint8Array; commitHash: string } {
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
  return { chunkHashes, commitBytes, commitHash };
}

function assembleEnvelope(
  input: VaultChangeEnvelopeInput,
  chunkBytes: readonly Uint8Array[],
  encoded: { chunkHashes: string[]; commitBytes: Uint8Array; commitHash: string },
): { chunks: ImmutableObject[]; commit: ImmutableObject } {
  return {
    chunks: chunkBytes.map((bytes, index) => ({
      key: changeChunkKey(input.prefix, input.repositoryId, encoded.chunkHashes[index]),
      hash: encoded.chunkHashes[index],
      bytes,
    })),
    commit: {
      key: commitKey(input.prefix, input.repositoryId, input.writerId, input.sequence, encoded.commitHash),
      hash: encoded.commitHash,
      bytes: encoded.commitBytes,
    },
  };
}

function assertBuildInput(input: VaultChangeEnvelopeInput, chunkMutationLimit: number): void {
  if (!Number.isSafeInteger(chunkMutationLimit) || chunkMutationLimit < 1 || chunkMutationLimit > protocolLimits.chunkMutations) {
    throw new Error("invalid Change Chunk mutation limit");
  }
  if (input.mutations.length === 0) throw new Error("Commit requires at least one Mutation");
}

function assertNoDuplicatePaths(mutations: readonly VaultMutation[]): void {
  for (let index = 1; index < mutations.length; index += 1) {
    if (mutations[index - 1].path === mutations[index].path) throw new Error("Commit contains a duplicate Vault path");
  }
}

async function copyAndSortMutationsIncrementally(
  input: readonly VaultMutation[],
  workSlice: number,
  yieldToIdle: (phase?: IncrementalBuildPhase) => Promise<void>,
): Promise<VaultMutation[]> {
  let source: VaultMutation[] = [];
  let alreadySorted = true;
  for (let index = 0; index < input.length; index += 1) {
    const mutation = copyMutation(input[index]);
    if (index > 0 && compareUtf8(source[index - 1].path, mutation.path) > 0) alreadySorted = false;
    source.push(mutation);
    if ((index + 1) % workSlice === 0) await yieldToIdle("copy");
  }
  if (alreadySorted) return source;
  let target = new Array<VaultMutation>(source.length);
  let operations = 0;
  for (let width = 1; width < source.length; width *= 2) {
    for (let left = 0; left < source.length; left += width * 2) {
      const middle = Math.min(left + width, source.length);
      const right = Math.min(left + width * 2, source.length);
      let first = left;
      let second = middle;
      for (let output = left; output < right; output += 1) {
        target[output] = second >= right || (first < middle && compareUtf8(source[first].path, source[second].path) <= 0)
          ? source[first++]
          : source[second++];
        operations += 1;
        if (operations >= workSlice) {
          operations = 0;
          await yieldToIdle("sort");
        }
      }
    }
    [source, target] = [target, source];
  }
  return source;
}

async function defaultYieldToIdle(_phase?: IncrementalBuildPhase): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function initialMutationGroups(mutations: VaultMutation[], limit: number): VaultMutation[][] {
  const groups: VaultMutation[][] = [];
  for (let index = 0; index < mutations.length; index += limit) groups.push(mutations.slice(index, index + limit));
  return groups;
}

function splitToByteBound(input: VaultChangeEnvelopeInput, mutations: VaultMutation[]): VaultMutation[][] {
  // The largest legal index/count header is used as a conservative probe. Actual headers can only be shorter.
  if (encodeChunk(input, mutations, protocolLimits.commitChunks - 1, protocolLimits.commitChunks).byteLength <= protocolLimits.changeChunkBytes) {
    return [mutations];
  }
  if (mutations.length === 1) throw new Error(`Vault Mutation cannot fit within the ${protocolLimits.changeChunkBytes} byte Change Chunk limit`);
  const middle = Math.ceil(mutations.length / 2);
  return [
    ...splitToByteBound(input, mutations.slice(0, middle)),
    ...splitToByteBound(input, mutations.slice(middle)),
  ];
}

function encodeChunk(
  input: VaultChangeEnvelopeInput,
  mutations: readonly VaultMutation[],
  chunkIndex: number,
  chunkCount: number,
): Uint8Array {
  return encoder.encode(canonicalizeProtocolJson({
    protocol: 1,
    repositoryId: input.repositoryId,
    descriptorHash: input.descriptorHash,
    channel: "vault",
    chunkIndex,
    chunkCount,
    mutations: mutations.map((mutation) => mutation.kind === "put"
      ? { path: mutation.path, kind: "put", blobHash: mutation.blob?.hash, size: mutation.blob?.size, parents: mutation.parents }
      : { path: mutation.path, kind: "delete", parents: mutation.parents }),
  }));
}

function copyMutation(mutation: VaultMutation): VaultMutation {
  return {
    ...mutation,
    parents: [...mutation.parents].sort(compareUtf8),
    ...(mutation.blob ? { blob: { ...mutation.blob } } : {}),
  };
}

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

function compareBytes(leftBytes: Uint8Array, rightBytes: Uint8Array): number {
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}
