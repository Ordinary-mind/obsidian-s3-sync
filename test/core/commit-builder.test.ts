import { describe, expect, it } from "vitest";
import { buildVaultChangeEnvelope, buildVaultMultiChunkEnvelope, buildVaultMultiChunkEnvelopeIncremental } from "../../core/commit-builder";
import { parseAndValidateProtocolObject } from "../../protocol/validation";
import { InMemoryRepositoryCore } from "../../core/repository";
import { receiveCommitBytes } from "../../core/receive-repository";
import { groupEquivalentHeads } from "../../core/register";
import { protocolLimits } from "../../protocol/limits";

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

  it("splits before either the mutation-count or canonical-byte Chunk bound is exceeded", () => {
    const base = { prefix: "", repositoryId: "123e4567-e89b-42d3-a456-426614174000", descriptorHash: "a".repeat(64), writerId: "123e4567-e89b-42d3-a456-426614174001", sequence: "00000000000000000001", previousCommitHash: null, createdAt: "2026-07-12T00:00:00.000Z", kind: "bootstrap" as const, clientVersion: "0.1.0" };
    const mutations = Array.from({ length: protocolLimits.chunkMutations }, (_, index) => ({
      path: `notes/${index.toString().padStart(4, "0")}-${"x".repeat(980)}.md`,
      kind: "delete" as const,
      parents: [],
    }));
    const result = buildVaultMultiChunkEnvelope({ ...base, mutations });
    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.chunks.every((chunk) => chunk.bytes.byteLength <= protocolLimits.changeChunkBytes)).toBe(true);
    const commit = parseAndValidateProtocolObject("commit", result.commit.bytes) as any;
    expect(commit.changeChunkHashes).toHaveLength(result.chunks.length);
  });

  it("incrementally sorts a large bootstrap with observable idle yields and deterministic output", async () => {
    const base = { prefix: "", repositoryId: "123e4567-e89b-42d3-a456-426614174000", descriptorHash: "a".repeat(64), writerId: "123e4567-e89b-42d3-a456-426614174001", sequence: "00000000000000000001", previousCommitHash: null, createdAt: "2026-07-12T00:00:00.000Z", kind: "bootstrap" as const, clientVersion: "0.1.0" };
    const mutations = Array.from({ length: 257 }, (_, index) => ({ path: `notes/${(256 - index).toString().padStart(4, "0")}.md`, kind: "delete" as const, parents: [] }));
    let yields = 0;
    const incremental = await buildVaultMultiChunkEnvelopeIncremental({ ...base, mutations }, {
      workSlice: 16,
      chunkMutationLimit: 64,
      yieldToIdle: async () => { yields += 1; },
    });
    const synchronous = buildVaultMultiChunkEnvelope({ ...base, mutations }, 64);
    expect(yields).toBeGreaterThan(10);
    expect(incremental.commit.hash).toBe(synchronous.commit.hash);
    expect(incremental.chunks.map((chunk) => chunk.hash)).toEqual(synchronous.chunks.map((chunk) => chunk.hash));
  });

  it("merges concurrent bootstrap roots in one repository and isolates different repositoryIds", () => {
    const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
    const descriptorHash = "a".repeat(64);
    const base = {
      prefix: "",
      repositoryId,
      descriptorHash,
      sequence: "00000000000000000001",
      previousCommitHash: null,
      createdAt: "2026-07-14T00:00:00.000Z",
      kind: "bootstrap" as const,
      clientVersion: "0.1.0",
    };
    const rootPut = (path: string, hash: string) => ({ path, kind: "put" as const, blob: { hash, size: 1 }, parents: [] });
    const first = buildVaultMultiChunkEnvelope({
      ...base,
      writerId: "123e4567-e89b-42d3-a456-426614174001",
      mutations: [rootPut("a.md", "b".repeat(64)), rootPut("same.md", "c".repeat(64)), rootPut("conflict.md", "d".repeat(64))],
    }, 2);
    const second = buildVaultMultiChunkEnvelope({
      ...base,
      writerId: "123e4567-e89b-42d3-a456-426614174002",
      mutations: [rootPut("b.md", "e".repeat(64)), rootPut("same.md", "c".repeat(64)), rootPut("conflict.md", "f".repeat(64))],
    }, 2);
    const repository = new InMemoryRepositoryCore();
    receiveCommitBytes(repository, repositoryId, descriptorHash, first.commit.bytes, first.chunks.map((chunk) => chunk.bytes));
    receiveCommitBytes(repository, repositoryId, descriptorHash, second.commit.bytes, second.chunks.map((chunk) => chunk.bytes));
    expect(repository.register(repositoryId, "vault", "a.md").disposition).toBe("resolved");
    expect(repository.register(repositoryId, "vault", "b.md").disposition).toBe("resolved");
    const same = repository.register(repositoryId, "vault", "same.md");
    expect(same.heads).toHaveLength(2);
    expect(groupEquivalentHeads(same.heads, new Map(same.heads.map((head) => [head, repository.version(head)!.blob!.hash])))).toHaveLength(1);
    expect(repository.register(repositoryId, "vault", "conflict.md")).toMatchObject({ disposition: "concurrent" });

    const otherRepositoryId = "123e4567-e89b-42d3-a456-426614174010";
    const other = buildVaultMultiChunkEnvelope({
      ...base,
      repositoryId: otherRepositoryId,
      writerId: "123e4567-e89b-42d3-a456-426614174011",
      mutations: [rootPut("isolated.md", "1".repeat(64))],
    });
    receiveCommitBytes(repository, otherRepositoryId, descriptorHash, other.commit.bytes, other.chunks.map((chunk) => chunk.bytes));
    expect(repository.allRegisters(repositoryId).has("vault:isolated.md")).toBe(false);
    expect(repository.allRegisters(otherRepositoryId).has("vault:a.md")).toBe(false);
  });
});
