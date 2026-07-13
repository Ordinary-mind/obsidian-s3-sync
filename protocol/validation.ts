import Ajv2020 from "ajv/dist/2020.js";

import schema from "./schemas/v1.schema.json";
import { BoundedProtocolObject, parseBoundedProtocolJson } from "./json";
import {
  ProtocolChunk,
  ProtocolCommit,
  ProtocolViolation,
  validateChangeChunkObject,
  validateCommitFields,
  validateCommitEnvelope,
  validateConfigTreeProfile,
  validateRepositoryDescriptor,
  isUtf8SortedUnique,
} from "./semantics";
import { sha256Hex } from "./hash";
import { assertCommitKey, assertContentAddressedKey, descriptorKey } from "./keys";
import { defaultCaseFold151, normalizeNfc151 } from "./unicode";

type SchemaDefinition = "RepositoryDescriptor" | "ConfigTree" | "ChangeChunk" | "Commit";

export class ProtocolValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProtocolValidationError";
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema);

export function parseAndValidateProtocolObject(kind: BoundedProtocolObject, bytes: Uint8Array): Record<string, unknown> {
  const object = parseBoundedProtocolJson(kind, bytes);
  const definition = definitionFor(kind);
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${definition}`);
  if (!validate) throw new Error(`missing protocol schema definition: ${definition}`);
  if (!validate(object)) {
    throw new ProtocolValidationError("schema-invalid", ajv.errorsText(validate.errors));
  }
  const semanticViolations = singleObjectViolations(kind, object);
  if (semanticViolations.length > 0) {
    throw new ProtocolValidationError("semantic-invalid", semanticViolations.join(","));
  }
  return object;
}

export function validateProtocolCommitEnvelope(
  descriptorHash: string,
  commit: ProtocolCommit,
  chunks: ProtocolChunk[],
  chunkHashes: string[],
): void {
  const violations = validateCommitEnvelope(descriptorHash, commit, chunks, chunkHashes);
  if (violations.length > 0) {
    throw new ProtocolValidationError("commit-envelope-invalid", violations.join(","));
  }
}

export function parseAndValidateCommitEnvelope(
  descriptorHash: string,
  commitBytes: Uint8Array,
  chunkBytes: Uint8Array[],
): { commit: ProtocolCommit; chunks: ProtocolChunk[]; chunkHashes: string[]; commitHash: string } {
  const commit = parseAndValidateProtocolObject("commit", commitBytes) as unknown as ProtocolCommit;
  const chunks = chunkBytes.map(
    (bytes) => parseAndValidateProtocolObject("change-chunk", bytes) as unknown as ProtocolChunk,
  );
  const chunkHashes = chunkBytes.map(sha256Hex);
  validateProtocolCommitEnvelope(descriptorHash, commit, chunks, chunkHashes);
  return { commit, chunks, chunkHashes, commitHash: sha256Hex(commitBytes) };
}

export function parseAndValidateBoundCommitEnvelope(
  repositoryId: string,
  descriptorHash: string,
  commitBytes: Uint8Array,
  chunkBytes: Uint8Array[],
): { commit: ProtocolCommit; chunks: ProtocolChunk[]; chunkHashes: string[]; commitHash: string } {
  const envelope = parseAndValidateCommitEnvelope(descriptorHash, commitBytes, chunkBytes);
  assertRepositoryBinding(envelope.commit as unknown as Record<string, unknown>, repositoryId, descriptorHash);
  for (const chunk of envelope.chunks) {
    assertRepositoryBinding(chunk as unknown as Record<string, unknown>, repositoryId, descriptorHash);
  }
  return envelope;
}

export function parseAndValidateKeyedCommitEnvelope(
  repositoryId: string,
  descriptorHash: string,
  commitKey: string,
  commitBytes: Uint8Array,
  chunkKeys: string[],
  chunkBytes: Uint8Array[],
): { commit: ProtocolCommit; chunks: ProtocolChunk[]; chunkHashes: string[]; commitHash: string } {
  const envelope = parseAndValidateBoundCommitEnvelope(repositoryId, descriptorHash, commitBytes, chunkBytes);
  if (chunkKeys.length !== envelope.chunkHashes.length) {
    throw new ProtocolValidationError("chunk-key-count-invalid", "chunk key count does not match Chunk body count");
  }
  for (let index = 0; index < chunkKeys.length; index += 1) {
    assertContentAddressedKey(chunkKeys[index], envelope.chunkHashes[index], ".json");
  }
  assertCommitKey(
    commitKey,
    envelope.commit.writerId,
    envelope.commit.sequence,
    envelope.commitHash,
  );
  return envelope;
}

interface PathTrieNode {
  terminal: boolean;
  children: Map<string, PathTrieNode>;
}

export class IncrementalCommitEnvelopeValidator {
  private acceptedChunks = 0;
  private mutationCount = 0;
  private lastVaultPath: string | undefined;
  private readonly foldedPutPaths = new Set<string>();
  private readonly putPathTrie: PathTrieNode = { terminal: false, children: new Map() };

  constructor(
    private readonly repositoryId: string,
    private readonly descriptorHash: string,
    readonly commit: ProtocolCommit,
    private readonly commitKey: string,
    commitHash: string,
  ) {
    assertRepositoryBinding(commit as unknown as Record<string, unknown>, repositoryId, descriptorHash);
    assertCommitKey(commitKey, commit.writerId, commit.sequence, commitHash);
    if (commit.changeChunkHashes.length === 0 || commit.changeChunkHashes.length > 1024) {
      throw new ProtocolValidationError("commit-envelope-invalid", "chunk-count-mismatch");
    }
    if (new Set(commit.changeChunkHashes).size !== commit.changeChunkHashes.length) {
      throw new ProtocolValidationError("commit-envelope-invalid", "duplicate-chunk-hash");
    }
  }

  acceptChunk(index: number, key: string, bytes: Uint8Array): ProtocolChunk {
    if (index !== this.acceptedChunks || index >= this.commit.changeChunkHashes.length) {
      throw new ProtocolValidationError("commit-envelope-invalid", "chunk-index-not-contiguous");
    }
    const hash = sha256Hex(bytes);
    assertContentAddressedKey(key, hash, ".json");
    if (hash !== this.commit.changeChunkHashes[index]) {
      throw new ProtocolValidationError("commit-envelope-invalid", "chunk-hash-order-mismatch");
    }
    const chunk = parseAndValidateProtocolObject("change-chunk", bytes) as unknown as ProtocolChunk;
    assertRepositoryBinding(chunk as unknown as Record<string, unknown>, this.repositoryId, this.descriptorHash);
    if (chunk.channel !== this.commit.channel) this.invalid("chunk-channel-mismatch");
    if (chunk.chunkIndex !== index || chunk.chunkCount !== this.commit.changeChunkHashes.length) this.invalid("chunk-index-not-contiguous");
    for (const mutation of chunk.mutations) this.acceptMutation(mutation);
    this.mutationCount += chunk.mutations.length;
    this.acceptedChunks += 1;
    return chunk;
  }

  finish(): void {
    if (this.acceptedChunks !== this.commit.changeChunkHashes.length) this.invalid("chunk-count-mismatch");
    if (this.commit.channel === "config" && (this.acceptedChunks !== 1 || this.mutationCount !== 1)) this.invalid("config-commit-shape");
    if (this.commit.kind === "parent-reduction" && (this.acceptedChunks !== 1 || this.mutationCount !== 1)) this.invalid("parent-reduction-shape");
  }

  private acceptMutation(mutation: ProtocolChunk["mutations"][number]): void {
    if (this.commit.channel === "vault") {
      const path = mutation.path!;
      if (this.lastVaultPath !== undefined && !isUtf8SortedUnique([this.lastVaultPath, path])) this.invalid("vault-global-order");
      this.lastVaultPath = path;
      if (mutation.kind === "put") this.acceptPutPath(path);
    }
    if (this.commit.kind === "bootstrap" && mutation.parents.length !== 0) this.invalid("bootstrap-parents");
    if (this.commit.kind === "conflict-resolution" && mutation.parents.length === 0) this.invalid("conflict-resolution-parents");
    if (this.commit.kind === "parent-reduction" && mutation.parents.length < 2) this.invalid("parent-reduction-parents");
  }

  private acceptPutPath(path: string): void {
    const folded = defaultCaseFold151(normalizeNfc151(path));
    if (this.foldedPutPaths.has(folded)) this.invalid("vault-global-case-alias");
    this.foldedPutPaths.add(folded);
    let node = this.putPathTrie;
    const segments = folded.split("/");
    for (let index = 0; index < segments.length; index += 1) {
      if (node.terminal) this.invalid("vault-global-path-prefix-conflict");
      const child = node.children.get(segments[index]) ?? { terminal: false, children: new Map<string, PathTrieNode>() };
      node.children.set(segments[index], child);
      node = child;
    }
    if (node.children.size > 0) this.invalid("vault-global-path-prefix-conflict");
    node.terminal = true;
  }

  private invalid(violation: ProtocolViolation): never {
    throw new ProtocolValidationError("commit-envelope-invalid", violation);
  }
}

export function assertRepositoryBinding(
  object: Record<string, unknown>,
  repositoryId: string,
  descriptorHash: string,
): void {
  if (object.repositoryId !== repositoryId || object.descriptorHash !== descriptorHash) {
    throw new ProtocolValidationError(
      "repository-binding-invalid",
      "object repositoryId or descriptorHash does not match the verified repository",
    );
  }
}

export function parseAndValidateBoundObject(
  kind: Exclude<BoundedProtocolObject, "descriptor">,
  bytes: Uint8Array,
  repositoryId: string,
  descriptorHash: string,
): Record<string, unknown> {
  const object = parseAndValidateProtocolObject(kind, bytes);
  assertRepositoryBinding(object, repositoryId, descriptorHash);
  return object;
}

export function verifyRepositoryDescriptor(bytes: Uint8Array): {
  descriptor: Record<string, unknown>;
  descriptorHash: string;
} {
  const descriptor = parseAndValidateProtocolObject("descriptor", bytes);
  return { descriptor, descriptorHash: sha256Hex(bytes) };
}

export function verifyRepositoryDescriptorAtKey(
  prefix: string,
  key: string,
  bytes: Uint8Array,
): { descriptor: Record<string, unknown>; descriptorHash: string } {
  const verified = verifyRepositoryDescriptor(bytes);
  const repositoryId = verified.descriptor.repositoryId;
  if (typeof repositoryId !== "string" || key !== descriptorKey(prefix, repositoryId)) {
    throw new ProtocolValidationError("descriptor-key-invalid", "descriptor key does not match descriptor repositoryId");
  }
  return verified;
}

function definitionFor(kind: BoundedProtocolObject): SchemaDefinition {
  const definitions: Record<BoundedProtocolObject, SchemaDefinition> = {
    descriptor: "RepositoryDescriptor",
    "config-tree": "ConfigTree",
    "change-chunk": "ChangeChunk",
    commit: "Commit",
  };
  return definitions[kind];
}

function singleObjectViolations(kind: BoundedProtocolObject, object: Record<string, unknown>): string[] {
  if (kind === "descriptor") return validateRepositoryDescriptor(object as never);
  if (kind === "config-tree") return validateConfigTreeProfile(object as never);
  if (kind === "commit") return validateCommitFields(object as unknown as ProtocolCommit);
  if (kind === "change-chunk") return validateChangeChunkObject(object as unknown as ProtocolChunk);
  return [];
}
