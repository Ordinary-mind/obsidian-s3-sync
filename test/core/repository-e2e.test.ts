import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { InMemoryRepositoryCore } from "../../core";
import { receiveCommitBytes } from "../../core";
import { parseRepositoryState, serializeRepositoryState } from "../../core/repository-state";

describe("v1 repository receive and recovery workflow", () => {
  it("verifies fixed remote bytes, reconstructs heads, persists and restores the same state", () => {
    const vector = JSON.parse(readFileSync(new URL("../../protocol/vectors/vault-bootstrap-multi-chunk.json", import.meta.url), "utf8"));
    const repository = new InMemoryRepositoryCore();
    receiveCommitBytes(repository, vector.commit.object.repositoryId, vector.commit.object.descriptorHash, new TextEncoder().encode(vector.commit.canonicalJson), vector.chunks.map((chunk: { canonicalJson: string }) => new TextEncoder().encode(chunk.canonicalJson)));
    const serialized = serializeRepositoryState(repository.snapshotVersions());
    const recovered = new InMemoryRepositoryCore();
    recovered.restoreVersions(parseRepositoryState(serialized).versions);
    expect(recovered.allRegisters(vector.commit.object.repositoryId)).toEqual(repository.allRegisters(vector.commit.object.repositoryId));
  });

  it("isolates repository generations sharing one Prefix", () => {
    const oldRepositoryId = "123e4567-e89b-42d3-a456-426614174000";
    const newRepositoryId = "123e4567-e89b-42d3-a456-426614174010";
    const repository = new InMemoryRepositoryCore();
    repository.ingest({
      repositoryId: oldRepositoryId,
      channel: "vault",
      logicalKey: "notes/a.md",
      versionId: "old-generation",
      parents: [],
      blob: { hash: "a".repeat(64), size: 1 },
    });
    repository.ingest({
      repositoryId: newRepositoryId,
      channel: "vault",
      logicalKey: "notes/a.md",
      versionId: "new-generation",
      parents: [],
      blob: { hash: "b".repeat(64), size: 1 },
    });

    expect(repository.register(oldRepositoryId, "vault", "notes/a.md").heads).toEqual(["old-generation"]);
    expect(repository.register(newRepositoryId, "vault", "notes/a.md").heads).toEqual(["new-generation"]);
    expect(repository.allRegisters(oldRepositoryId).get("vault:notes/a.md")?.heads).not.toContain("new-generation");
  });
});
