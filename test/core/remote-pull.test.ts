import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { changeChunkKey, configTreeKey } from "../../protocol/keys";
import { sha256Hex } from "../../protocol/hash";
import { canonicalizeProtocolJson } from "../../protocol/json";
import { pullCommitIntoRepository } from "../../core/remote-pull";
import { InMemoryRepositoryCore } from "../../core/repository";
import { objectBodyFromBytes } from "../../core/object-store";

describe("remote Commit pull", () => {
  it("fetches every referenced Chunk before admitting a Commit into the core", async () => {
    const vector = JSON.parse(readFileSync(new URL("../../protocol/vectors/vault-bootstrap-multi-chunk.json", import.meta.url), "utf8"));
    const objects = new Map<string, Uint8Array>();
    const root = `.obsidian-s3-sync/v1/repositories/${vector.commit.object.repositoryId}`;
    const commitKey = `${root}/commits/${vector.commit.object.writerId}/${vector.commit.object.sequence}-${vector.commit.sha256}.json`;
    objects.set(commitKey, new TextEncoder().encode(vector.commit.canonicalJson));
    vector.chunks.forEach((chunk: { sha256: string; canonicalJson: string }) => objects.set(changeChunkKey("", vector.commit.object.repositoryId, chunk.sha256), new TextEncoder().encode(chunk.canonicalJson)));
    const store = { getStream: async (key: string) => { const bytes = objects.get(key); if (!bytes) throw new Error(`missing ${key}`); return objectBodyFromBytes(bytes); }, head: async () => ({ size: 0 }), list: async () => ({ keys: [] }), putImmutable: async () => undefined };
    const repository = new InMemoryRepositoryCore();
    await pullCommitIntoRepository(store, repository, "", vector.commit.object.repositoryId, vector.commit.object.descriptorHash, commitKey);
    expect(repository.register(vector.commit.object.repositoryId, "vault", "notes/first.md").heads).toHaveLength(1);
  });

  it("fetches and verifies the referenced ConfigTree before admitting a Config snapshot", async () => {
    const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
    const descriptorHash = "a".repeat(64);
    const tree = {
      protocol: 1,
      repositoryId,
      descriptorHash,
      profile: {
        schema: 1,
        baseFiles: ["app.json"],
        syncThemes: false,
        syncSnippets: false,
        minimumTargetAppVersion: "1.7.7",
        portablePluginIds: [],
        pluginPackages: [],
        pluginData: [],
      },
      enabledCommunityPlugins: [],
      items: [{ path: "app.json", kind: "put", blobHash: "b".repeat(64), size: 1 }],
    };
    const treeBytes = new TextEncoder().encode(canonicalizeProtocolJson(tree));
    const treeHash = sha256Hex(treeBytes);
    const chunk = {
      protocol: 1,
      repositoryId,
      descriptorHash,
      channel: "config",
      chunkIndex: 0,
      chunkCount: 1,
      mutations: [{ key: "portable", kind: "snapshot", treeHash, parents: [] }],
    };
    const chunkBytes = new TextEncoder().encode(canonicalizeProtocolJson(chunk));
    const chunkHash = sha256Hex(chunkBytes);
    const commit = {
      protocol: 1,
      repositoryId,
      descriptorHash,
      writerId: "123e4567-e89b-42d3-a456-426614174001",
      sequence: "00000000000000000001",
      previousCommitHash: null,
      createdAt: "2026-07-13T00:00:00.000Z",
      channel: "config",
      kind: "bootstrap",
      changeChunkHashes: [chunkHash],
      clientVersion: "0.1.0",
    };
    const commitBytes = new TextEncoder().encode(canonicalizeProtocolJson(commit));
    const commitHash = sha256Hex(commitBytes);
    const root = `.obsidian-s3-sync/v1/repositories/${repositoryId}`;
    const commitKey = `${root}/commits/${commit.writerId}/${commit.sequence}-${commitHash}.json`;
    const objects = new Map([
      [commitKey, commitBytes],
      [changeChunkKey("", repositoryId, chunkHash), chunkBytes],
      [configTreeKey("", repositoryId, treeHash), treeBytes],
    ]);
    const store = { getStream: async (key: string) => {
      const bytes = objects.get(key);
      if (!bytes) throw new Error(`missing ${key}`);
      return objectBodyFromBytes(bytes);
    }, head: async () => ({ size: 0 }), list: async () => ({ keys: [] }), putImmutable: async () => undefined };
    const repository = new InMemoryRepositoryCore();

    await pullCommitIntoRepository(store, repository, "", repositoryId, descriptorHash, commitKey, { configDir: ".obsidian", historicalConfigDirs: [] });

    expect(repository.register(repositoryId, "config", "portable")).toMatchObject({ heads: [`${commitHash}:0:0`] });
  });
});
