import { describe, expect, it } from "vitest";
import { buildVaultChangeEnvelope, buildVaultMultiChunkEnvelope } from "../../core/commit-builder";
import { parseAndValidateProtocolObject } from "../../protocol/validation";

describe("v1 Vault Commit builder", () => {
  it("canonicalizes, hashes and keys an immutable single-Chunk envelope", () => {
    const result = buildVaultChangeEnvelope({ prefix: "", repositoryId: "123e4567-e89b-42d3-a456-426614174000", descriptorHash: "a".repeat(64), writerId: "123e4567-e89b-42d3-a456-426614174001", sequence: "00000000000000000001", previousCommitHash: null, createdAt: "2026-07-12T00:00:00.000Z", kind: "bootstrap", clientVersion: "0.1.0", mutations: [{ path: "notes/a.md", kind: "put", blob: { hash: "b".repeat(64), size: 1 }, parents: [] }] });
    expect(result.chunk.key).toContain(`/changes/sha256/${result.chunk.hash.slice(0, 2)}/`);
    expect(result.commit.key).toContain(`/commits/123e4567-e89b-42d3-a456-426614174001/00000000000000000001-`);
  });
  it("sorts globally, partitions multiple Chunks and rejects duplicate paths", () => {
    const base = { prefix: "", repositoryId: "123e4567-e89b-42d3-a456-426614174000", descriptorHash: "a".repeat(64), writerId: "123e4567-e89b-42d3-a456-426614174001", sequence: "00000000000000000001", previousCommitHash: null, createdAt: "2026-07-12T00:00:00.000Z", kind: "bootstrap" as const, clientVersion: "0.1.0" };
    const mutations = ["notes/c.md", "notes/a.md", "notes/b.md"].map((path) => ({ path, kind: "delete" as const, parents: [] }));
    const result = buildVaultMultiChunkEnvelope({ ...base, mutations }, 2);
    expect(result.chunks).toHaveLength(2);
    const decoded = result.chunks.map((chunk) => parseAndValidateProtocolObject("change-chunk", chunk.bytes) as any);
    expect(decoded.map((chunk) => chunk.chunkIndex)).toEqual([0, 1]);
    expect(decoded.flatMap((chunk) => chunk.mutations.map((mutation: any) => mutation.path))).toEqual(["notes/a.md", "notes/b.md", "notes/c.md"]);
    expect(() => buildVaultMultiChunkEnvelope({ ...base, mutations: [mutations[0], mutations[0]] }, 1)).toThrow("duplicate Vault path");
  });
});
