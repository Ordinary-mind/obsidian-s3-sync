import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createDefaultConfigProfile } from "../../core/config-profile";
import { buildVaultChangeEnvelope } from "../../core/commit-builder";
import { objectBodyFromBytes, type ObjectStore } from "../../core/object-store";
import { changeChunkKey } from "../../protocol/keys";
import { V1RepositoryService } from "../../src/v1-service";

describe("V1 repository service", () => {
  it("reuses verified Commits within one service session and rebuilds after a listed key disappears", async () => {
    const descriptor = JSON.parse(readFileSync(new URL("../../protocol/vectors/repository-descriptor-basic.json", import.meta.url), "utf8"));
    const first = JSON.parse(readFileSync(new URL("../../protocol/vectors/vault-bootstrap-multi-chunk.json", import.meta.url), "utf8"));
    const repositoryId = descriptor.object.repositoryId as string;
    const descriptorHash = descriptor.sha256 as string;
    const root = `.obsidian-s3-sync/v1/repositories/${repositoryId}`;
    const firstCommitKey = `${root}/commits/${first.commit.object.writerId}/${first.commit.object.sequence}-${first.commit.sha256}.json`;
    const second = buildVaultChangeEnvelope({
      prefix: "team",
      repositoryId,
      descriptorHash,
      writerId: "123e4567-e89b-42d3-a456-426614174099",
      sequence: "00000000000000000001",
      previousCommitHash: null,
      createdAt: "2026-07-20T00:00:00.000Z",
      kind: "bootstrap",
      clientVersion: "0.1.9",
      mutations: [{ path: "notes/third.md", kind: "put", blob: { hash: "f".repeat(64), size: 5 }, parents: [] }],
    });
    const objects = new Map<string, Uint8Array>([
      [`team/${descriptor.key}`, new TextEncoder().encode(descriptor.canonicalJson)],
      [`team/${firstCommitKey}`, new TextEncoder().encode(first.commit.canonicalJson)],
      ...first.chunks.map((chunk: { sha256: string; canonicalJson: string }) => [
        changeChunkKey("team", repositoryId, chunk.sha256),
        new TextEncoder().encode(chunk.canonicalJson),
      ] as [string, Uint8Array]),
      [second.commit.key, second.commit.bytes],
      [second.chunk.key, second.chunk.bytes],
    ]);
    let commitKeys = [`team/${firstCommitKey}`];
    let listCalls = 0;
    const gets = new Map<string, number>();
    const store = {
      list: async () => {
        listCalls += 1;
        return { keys: [...commitKeys] };
      },
      getStream: async (key: string) => {
        gets.set(key, (gets.get(key) ?? 0) + 1);
        const bytes = objects.get(key);
        if (!bytes) throw new Error(`missing ${key}`);
        return objectBodyFromBytes(bytes);
      },
      head: async () => ({ size: 0 }),
      putImmutable: async () => undefined,
    } as ObjectStore;
    const service = new V1RepositoryService({
      endpoint: "https://s3.example.com",
      region: "test",
      bucket: "vault",
      prefix: "team",
      forcePathStyle: true,
      accessKeyId: "id",
      secretAccessKey: "secret",
      autoSync: false,
      ignoredPatterns: "",
      configProfile: createDefaultConfigProfile("1.8.0"),
    });
    Object.defineProperty(service, "store", { value: () => store });

    const initial = await service.inspectRepositoryState(repositoryId, descriptorHash);
    const unchanged = await service.inspectRepositoryState(repositoryId, descriptorHash);
    expect(initial.acceptedCommits).toHaveLength(1);
    expect(unchanged.acceptedCommits).toHaveLength(1);
    expect(gets.get(`team/${descriptor.key}`)).toBe(1);
    expect(gets.get(`team/${firstCommitKey}`)).toBe(1);
    for (const chunk of first.chunks) {
      expect(gets.get(changeChunkKey("team", repositoryId, chunk.sha256))).toBe(1);
    }

    commitKeys = [...commitKeys, second.commit.key];
    const extended = await service.inspectRepositoryState(repositoryId, descriptorHash);
    await service.inspectRepositoryState(repositoryId, descriptorHash);
    expect(extended.acceptedCommits).toHaveLength(2);
    expect(extended.observations.some((entry) => entry.key === "vault:notes/third.md")).toBe(true);
    expect(gets.get(`team/${firstCommitKey}`)).toBe(1);
    expect(gets.get(second.commit.key)).toBe(1);
    expect(gets.get(second.chunk.key)).toBe(1);

    commitKeys = [second.commit.key];
    const rebuilt = await service.inspectRepositoryState(repositoryId, descriptorHash);
    expect(rebuilt.acceptedCommits).toHaveLength(1);
    expect(rebuilt.observations.some((entry) => entry.key === "vault:notes/first.md")).toBe(false);
    expect(gets.get(second.commit.key)).toBe(2);
    expect(gets.get(second.chunk.key)).toBe(2);
    expect(listCalls).toBe(5);
  });

  it("stops a repeated commit-list continuation token instead of looping forever", async () => {
    const service = new V1RepositoryService({
      endpoint: "https://s3.example.com",
      region: "test",
      bucket: "vault",
      prefix: "team",
      forcePathStyle: true,
      accessKeyId: "id",
      secretAccessKey: "secret",
      autoSync: false,
      ignoredPatterns: "",
      configProfile: createDefaultConfigProfile("1.8.0"),
    });
    let calls = 0;
    const store = {
      list: async () => {
        calls += 1;
        return { keys: [], continuationToken: "repeat" };
      },
    } as unknown as ObjectStore;
    Object.defineProperty(service, "store", { value: () => store });

    await expect(service.listCommitKeys("123e4567-e89b-42d3-a456-426614174000"))
      .rejects.toMatchObject({
        code: "OBJECT_STORE_PAGINATION_TOKEN_REPEATED",
        category: "integrity",
      });
    expect(calls).toBe(2);
  });
});
