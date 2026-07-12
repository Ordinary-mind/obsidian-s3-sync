import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { changeChunkKey } from "../../protocol/keys";
import { pullCommitIntoRepository } from "../../core/remote-pull";
import { InMemoryRepositoryCore } from "../../core/repository";

describe("remote Commit pull", () => {
  it("fetches every referenced Chunk before admitting a Commit into the core", async () => {
    const vector = JSON.parse(readFileSync(new URL("../../protocol/vectors/vault-bootstrap-multi-chunk.json", import.meta.url), "utf8"));
    const objects = new Map<string, Uint8Array>();
    const root = `.obsidian-s3-sync/v1/repositories/${vector.commit.object.repositoryId}`;
    const commitKey = `${root}/commits/${vector.commit.object.writerId}/${vector.commit.object.sequence}-${vector.commit.sha256}.json`;
    objects.set(commitKey, new TextEncoder().encode(vector.commit.canonicalJson));
    vector.chunks.forEach((chunk: { sha256: string; canonicalJson: string }) => objects.set(changeChunkKey("", vector.commit.object.repositoryId, chunk.sha256), new TextEncoder().encode(chunk.canonicalJson)));
    const store = { get: async (key: string) => { const bytes = objects.get(key); if (!bytes) throw new Error(`missing ${key}`); return bytes; }, head: async () => ({ size: 0 }), list: async () => ({ keys: [] }), putImmutable: async () => undefined };
    const repository = new InMemoryRepositoryCore();
    await pullCommitIntoRepository(store, repository, "", vector.commit.object.repositoryId, vector.commit.object.descriptorHash, commitKey);
    expect(repository.register(vector.commit.object.repositoryId, "vault", "notes/first.md").heads).toHaveLength(1);
  });
});
