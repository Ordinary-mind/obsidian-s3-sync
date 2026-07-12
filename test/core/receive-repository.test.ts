import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { InMemoryRepositoryCore } from "../../core/repository";
import { receiveCommitBytes, receiveKeyedCommitBytes } from "../../core/receive-repository";

describe("end-to-end verified repository receive", () => {
  it("accepts canonical fixed bytes only after protocol binding validation", () => {
    const vector = JSON.parse(readFileSync(new URL("../../protocol/vectors/vault-bootstrap-multi-chunk.json", import.meta.url), "utf8"));
    const repository = new InMemoryRepositoryCore();
    const ids = receiveCommitBytes(repository, vector.commit.object.repositoryId, vector.commit.object.descriptorHash, new TextEncoder().encode(vector.commit.canonicalJson), vector.chunks.map((chunk: { canonicalJson: string }) => new TextEncoder().encode(chunk.canonicalJson)));
    expect(ids).toHaveLength(2);
    expect(repository.register(vector.commit.object.repositoryId, "vault", "notes/first.md").heads).toEqual([ids[0]]);
  });
  it("rejects a physical Chunk key that does not bind its exact bytes", () => {
    const vector = JSON.parse(readFileSync(new URL("../../protocol/vectors/vault-bootstrap-multi-chunk.json", import.meta.url), "utf8"));
    const root = `.obsidian-s3-sync/v1/repositories/${vector.commit.object.repositoryId}`;
    const repository = new InMemoryRepositoryCore();
    expect(() => receiveKeyedCommitBytes(repository, vector.commit.object.repositoryId, vector.commit.object.descriptorHash, `${root}/commits/${vector.commit.object.writerId}/${vector.commit.object.sequence}-${vector.commit.sha256}.json`, new TextEncoder().encode(vector.commit.canonicalJson), vector.chunks.map((chunk: { sha256: string }) => `${root}/changes/sha256/00/${chunk.sha256}.json`), vector.chunks.map((chunk: { canonicalJson: string }) => new TextEncoder().encode(chunk.canonicalJson)))).toThrow("key-body-hash-mismatch");
  });
});
