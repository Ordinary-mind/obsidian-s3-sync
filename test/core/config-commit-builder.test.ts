import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildConfigSnapshotEnvelope } from "../../core/config-commit-builder";

describe("ConfigTree snapshot Commit builder", () => {
  it("matches the frozen one-Chunk/one-Mutation vector byte-for-byte", () => {
    const vector = JSON.parse(readFileSync(new URL("../../protocol/vectors/config-change-and-resolution.json", import.meta.url), "utf8")).vectors[0];
    const commit = vector.commit.object;
    const mutation = vector.chunk.object.mutations[0];
    const built = buildConfigSnapshotEnvelope({
      prefix: "",
      repositoryId: commit.repositoryId,
      descriptorHash: commit.descriptorHash,
      writerId: commit.writerId,
      sequence: commit.sequence,
      previousCommitHash: commit.previousCommitHash,
      createdAt: commit.createdAt,
      clientVersion: commit.clientVersion,
      kind: commit.kind,
      treeHash: mutation.treeHash,
      parents: mutation.parents,
    });
    expect(new TextDecoder().decode(built.chunk.bytes)).toBe(vector.chunk.canonicalJson);
    expect(new TextDecoder().decode(built.commit.bytes)).toBe(vector.commit.canonicalJson);
  });

  it("rejects a change Commit that tries to exceed the frozen parent bound", () => {
    const base = {
      prefix: "", repositoryId: "123e4567-e89b-42d3-a456-426614174000", descriptorHash: "a".repeat(64),
      writerId: "123e4567-e89b-42d3-a456-426614174001", sequence: "00000000000000000001", previousCommitHash: null,
      createdAt: "2026-07-13T00:00:00.000Z", clientVersion: "0.1.0", treeHash: "b".repeat(64), kind: "change" as const,
    };
    expect(() => buildConfigSnapshotEnvelope({ ...base, parents: Array.from({ length: 1025 }, (_, index) => `${index.toString(16).padStart(64, "0")}:0:0`) })).toThrow();
  });
});
