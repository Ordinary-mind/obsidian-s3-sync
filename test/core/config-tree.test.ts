import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildConfigTreeObject, downloadConfigTree, publishConfigTree, type ProtocolConfigTree } from "../../core/config-tree";
import { objectBodyFromBytes } from "../../core/object-store";

describe("ConfigTree immutable object", () => {
  it("rebuilds the fixed vector byte-for-byte and publishes immutably", async () => {
    const vector = JSON.parse(readFileSync(new URL("../../protocol/vectors/config-tree-basic.json", import.meta.url), "utf8"));
    const sizes = new Map<string, number>(vector.object.items.map((item: { blobHash: string; size: number }) => [item.blobHash, item.size]));
    const object = buildConfigTreeObject("", vector.object as ProtocolConfigTree, { configDir: ".obsidian", historicalConfigDirs: [] }, sizes);
    expect(new TextDecoder().decode(object.bytes)).toBe(vector.canonicalJson);
    expect(object).toMatchObject({ hash: vector.sha256, key: vector.key });
    const writes: string[] = [];
    const store = {
      list: async () => ({ keys: [] }),
      head: async () => ({ size: object.bytes.byteLength }),
      getStream: async () => objectBodyFromBytes(object.bytes),
      putImmutable: async (key: string) => { writes.push(key); },
    };
    await publishConfigTree(store, object);
    expect(writes).toEqual([vector.key]);
  });

  it("downloads with Hash, descriptor and excluded-root validation", async () => {
    const vector = JSON.parse(readFileSync(new URL("../../protocol/vectors/config-tree-basic.json", import.meta.url), "utf8"));
    const bytes = new TextEncoder().encode(vector.canonicalJson);
    const store = {
      list: async () => ({ keys: [] }),
      head: async () => ({ size: bytes.byteLength }),
      getStream: async () => objectBodyFromBytes(bytes),
      putImmutable: async () => undefined,
    };
    await expect(downloadConfigTree(store, "", vector.object.repositoryId, vector.object.descriptorHash, vector.sha256, { configDir: ".obsidian", historicalConfigDirs: [] }))
      .resolves.toMatchObject({ repositoryId: vector.object.repositoryId, descriptorHash: vector.object.descriptorHash });
    await expect(downloadConfigTree(store, "", vector.object.repositoryId, "a".repeat(64), vector.sha256, { configDir: ".obsidian", historicalConfigDirs: [] }))
      .rejects.toThrow("does not match");
    const excluded = { ...vector.object, items: [{ path: ".obsidian-s3-sync-local/state.json", kind: "put", blobHash: "a".repeat(64), size: 1 }] };
    expect(() => buildConfigTreeObject("", excluded as ProtocolConfigTree, { configDir: ".obsidian", historicalConfigDirs: [] }, new Map([["a".repeat(64), 1]]))).toThrow("excluded repository path");
    expect(() => buildConfigTreeObject("", vector.object as ProtocolConfigTree, { configDir: ".obsidian", historicalConfigDirs: [] }, new Map())).toThrow("config-blob-pending");
  });
});
