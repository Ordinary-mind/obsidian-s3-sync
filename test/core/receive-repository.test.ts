import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { InMemoryRepositoryCore } from "../../core/repository";
import { receiveCommitBytes } from "../../core/receive-repository";

describe("end-to-end verified repository receive", () => {
  it("accepts canonical fixed bytes only after protocol binding validation", () => {
    const vector = JSON.parse(readFileSync(new URL("../../protocol/vectors/vault-bootstrap-multi-chunk.json", import.meta.url), "utf8"));
    const repository = new InMemoryRepositoryCore();
    const ids = receiveCommitBytes(repository, vector.commit.object.repositoryId, vector.commit.object.descriptorHash, new TextEncoder().encode(vector.commit.canonicalJson), vector.chunks.map((chunk: { canonicalJson: string }) => new TextEncoder().encode(chunk.canonicalJson)));
    expect(ids).toHaveLength(2);
    expect(repository.register(vector.commit.object.repositoryId, "vault", "notes/first.md").heads).toEqual([ids[0]]);
  });
});
