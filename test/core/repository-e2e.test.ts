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
});
