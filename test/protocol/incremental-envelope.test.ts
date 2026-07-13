import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { IncrementalCommitEnvelopeValidator, parseAndValidateKeyedCommitEnvelope } from "../../protocol/validation";
import { canonicalizeProtocolJson } from "../../protocol/json";
import { sha256Hex } from "../../protocol/hash";
import { changeChunkKey, commitKey } from "../../protocol/keys";

describe("incremental Commit envelope validation", () => {
  it("accepts the same fixed multi-Chunk vector as the array validator", () => {
    const vector = JSON.parse(readFileSync(new URL("../../protocol/vectors/vault-bootstrap-multi-chunk.json", import.meta.url), "utf8"));
    const commitBytes = new TextEncoder().encode(vector.commit.canonicalJson);
    const chunkBytes = vector.chunks.map((chunk: { canonicalJson: string }) => new TextEncoder().encode(chunk.canonicalJson));
    const chunkKeys = vector.chunks.map((chunk: { sha256: string }) => changeChunkKey("", vector.commit.object.repositoryId, chunk.sha256));
    const key = commitKey("", vector.commit.object.repositoryId, vector.commit.object.writerId, vector.commit.object.sequence, vector.commit.sha256);
    expect(() => parseAndValidateKeyedCommitEnvelope(vector.commit.object.repositoryId, vector.commit.object.descriptorHash, key, commitBytes, chunkKeys, chunkBytes)).not.toThrow();
    const validator = new IncrementalCommitEnvelopeValidator(vector.commit.object.repositoryId, vector.commit.object.descriptorHash, vector.commit.object, key, vector.commit.sha256);
    chunkBytes.forEach((bytes: Uint8Array, index: number) => validator.acceptChunk(index, chunkKeys[index], bytes));
    expect(() => validator.finish()).not.toThrow();
  });

  it("retains cross-Chunk case-fold checks without retaining Chunk bodies", () => {
    const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
    const descriptorHash = "a".repeat(64);
    const writerId = "123e4567-e89b-42d3-a456-426614174001";
    const chunks = ["A.md", "a.md"].map((path, chunkIndex) => new TextEncoder().encode(canonicalizeProtocolJson({ protocol: 1, repositoryId, descriptorHash, channel: "vault", chunkIndex, chunkCount: 2, mutations: [{ path, kind: "put", blobHash: "b".repeat(64), size: 1, parents: [] }] })));
    const hashes = chunks.map(sha256Hex);
    const commit = { protocol: 1 as const, repositoryId, descriptorHash, writerId, sequence: "00000000000000000001", previousCommitHash: null, createdAt: "2026-07-13T00:00:00.000Z", channel: "vault" as const, kind: "bootstrap" as const, changeChunkHashes: hashes, clientVersion: "0.1.0" };
    const commitBytes = new TextEncoder().encode(canonicalizeProtocolJson(commit));
    const commitHash = sha256Hex(commitBytes);
    const validator = new IncrementalCommitEnvelopeValidator(repositoryId, descriptorHash, commit, commitKey("", repositoryId, writerId, commit.sequence, commitHash), commitHash);
    validator.acceptChunk(0, changeChunkKey("", repositoryId, hashes[0]), chunks[0]);
    expect(() => validator.acceptChunk(1, changeChunkKey("", repositoryId, hashes[1]), chunks[1])).toThrow("vault-global-case-alias");
  });
});
