import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { changeChunkKey, configTreeKey } from "../../protocol/keys";
import { sha256Hex } from "../../protocol/hash";
import { canonicalizeProtocolJson } from "../../protocol/json";
import { pullCommitIntoRepository, pullCommitSetIntoRepository } from "../../core/remote-pull";
import { InMemoryRepositoryCore } from "../../core/repository";
import { objectBodyFromBytes } from "../../core/object-store";

describe("remote Commit pull", () => {
  it("pulls independent Commits with bounded concurrency and keeps deterministic results", async () => {
    const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
    const keys = ["commit-c.json", "commit-a.json", "commit-b.json"];
    let active = 0;
    let peakActive = 0;
    const store = {
      getStream: async () => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        throw new Error("missing test Commit");
      },
      head: async () => ({ size: 0 }),
      list: async () => ({ keys: [] }),
      putImmutable: async () => undefined,
    };

    const pulled = await pullCommitSetIntoRepository(
      store,
      "",
      repositoryId,
      "a".repeat(64),
      keys,
      { configDir: ".obsidian", historicalConfigDirs: [] },
      { concurrency: 2 },
    );

    expect(peakActive).toBe(2);
    expect(pulled.acceptedCommits).toEqual([]);
    expect(pulled.blockedCommitKeys.map((entry) => entry.key)).toEqual([...keys].sort());
  });

  it("fetches every referenced Chunk before admitting a Commit into the core", async () => {
    const vector = JSON.parse(readFileSync(new URL("../../protocol/vectors/vault-bootstrap-multi-chunk.json", import.meta.url), "utf8"));
    const objects = new Map<string, Uint8Array>();
    const root = `.obsidian-s3-sync/v1/repositories/${vector.commit.object.repositoryId}`;
    const commitKey = `${root}/commits/${vector.commit.object.writerId}/${vector.commit.object.sequence}-${vector.commit.sha256}.json`;
    objects.set(commitKey, new TextEncoder().encode(vector.commit.canonicalJson));
    vector.chunks.forEach((chunk: { sha256: string; canonicalJson: string }) => objects.set(changeChunkKey("", vector.commit.object.repositoryId, chunk.sha256), new TextEncoder().encode(chunk.canonicalJson)));
    const store = { getStream: async (key: string) => { const bytes = objects.get(key); if (!bytes) throw new Error(`missing ${key}`); return objectBodyFromBytes(bytes); }, head: async () => ({ size: 0 }), list: async () => ({ keys: [] }), putImmutable: async () => undefined };
    const repository = new InMemoryRepositoryCore();
    const staged = new Map<number, Uint8Array>();
    const stagingEvents: string[] = [];
    await pullCommitIntoRepository(store, repository, "", vector.commit.object.repositoryId, vector.commit.object.descriptorHash, commitKey, undefined, async () => ({
      write: async (index, bytes) => { stagingEvents.push(`write:${index}`); staged.set(index, new Uint8Array(bytes)); },
      read: async (index) => { stagingEvents.push(`read:${index}`); return staged.get(index)!; },
      dispose: async () => { stagingEvents.push("dispose"); staged.clear(); },
    }));
    expect(stagingEvents).toEqual([...vector.chunks.map((_: unknown, index: number) => `write:${index}`), ...vector.chunks.map((_: unknown, index: number) => `read:${index}`), "dispose"]);
    expect(repository.register(vector.commit.object.repositoryId, "vault", "notes/first.md").heads).toHaveLength(1);
    const missingCommitKey = `${root}/commits/${vector.commit.object.writerId}/00000000000000000002-${"f".repeat(64)}.json`;
    const malformedBytes = new TextEncoder().encode('{"protocol":1,"protocol":2}');
    const malformedHash = sha256Hex(malformedBytes);
    const malformedCommitKey = `${root}/commits/${vector.commit.object.writerId}/00000000000000000003-${malformedHash}.json`;
    objects.set(malformedCommitKey, malformedBytes);
    const isolated = await pullCommitSetIntoRepository(store, "", vector.commit.object.repositoryId, vector.commit.object.descriptorHash, [malformedCommitKey, missingCommitKey, commitKey], { configDir: ".obsidian", historicalConfigDirs: [] });
    expect(isolated.repository.register(vector.commit.object.repositoryId, "vault", "notes/first.md").heads).toHaveLength(1);
    expect(isolated.blockedCommitKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: missingCommitKey }),
      expect.objectContaining({ key: malformedCommitKey }),
    ]));
    expect(isolated.acceptedCommits).toHaveLength(1);

    const invalidObjects = new Map(objects);
    invalidObjects.set(changeChunkKey("", vector.commit.object.repositoryId, vector.chunks.at(-1).sha256), new TextEncoder().encode("tampered"));
    const invalidStore = { ...store, getStream: async (key: string) => { const bytes = invalidObjects.get(key); if (!bytes) throw new Error(`missing ${key}`); return objectBodyFromBytes(bytes); } };
    const untouched = new InMemoryRepositoryCore();
    let disposed = false;
    await expect(pullCommitIntoRepository(invalidStore, untouched, "", vector.commit.object.repositoryId, vector.commit.object.descriptorHash, commitKey, undefined, async () => ({ write: async () => undefined, read: async () => new Uint8Array(), dispose: async () => { disposed = true; } }))).rejects.toThrow();
    expect(untouched.allRegisters(vector.commit.object.repositoryId).size).toBe(0);
    expect(disposed).toBe(true);
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
