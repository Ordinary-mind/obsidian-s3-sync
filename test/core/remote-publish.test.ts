import { describe, expect, it } from "vitest";
import { publishEnvelope } from "../../core/remote-publish";
import { objectBodyFromBytes } from "../../core/object-store";
import { buildBlobObject } from "../../core/blob";
import { buildVaultMultiChunkEnvelope } from "../../core/commit-builder";
import { sha256Hex } from "../../protocol/hash";

describe("immutable envelope publication", () => {
  it("publishes immutable dependencies before Commit and verifies retry conflicts", async () => {
    const stored = new Map<string, Uint8Array>(); const order: string[] = [];
    const store = { list: async () => ({ keys: [] }), head: async () => ({ size: 0 }), getStream: async (key: string) => objectBodyFromBytes(stored.get(key)!), putImmutable: async (key: string, bytes: Uint8Array) => { order.push(key); if (stored.has(key)) throw new Error("exists"); stored.set(key, new Uint8Array(bytes)); } };
    const object = (key: string) => ({ key, hash: key, bytes: new Uint8Array([1]) });
    await publishEnvelope(store, { blobs: [object("blob")], configTrees: [object("tree")], chunks: [object("chunk")], commit: object("commit") });
    expect(order).toEqual(["blob", "tree", "chunk", "commit"]);
    await expect(publishEnvelope(store, { blobs: [object("blob")], configTrees: [], chunks: [], commit: object("commit") })).resolves.toBeUndefined();
  });
});

describe("immutable publication crash boundaries", () => {
  it("never exposes a Commit before every dependency is stored", async () => {
    const entries = ["blob", "tree", "chunk", "commit"].map((key, index) => ({ key, hash: key, bytes: new Uint8Array([index]) }));
    for (let crashIndex = 0; crashIndex < entries.length; crashIndex += 1) {
      for (const phase of ["before", "after"] as const) {
        const stored = new Map<string, Uint8Array>();
        let writeIndex = 0;
        const store = {
          list: async () => ({ keys: [...stored.keys()] }),
          head: async (key: string) => ({ size: stored.get(key)!.byteLength }),
          getStream: async () => { throw new Error("injected crash during recovery GET"); },
          putImmutable: async (key: string, bytes: Uint8Array) => {
            const current = writeIndex++;
            if (current === crashIndex && phase === "before") throw new Error("injected crash before write");
            stored.set(key, new Uint8Array(bytes));
            if (current === crashIndex && phase === "after") throw new Error("injected crash after write");
          },
        };
        await expect(publishEnvelope(store, { blobs: [entries[0]], configTrees: [entries[1]], chunks: [entries[2]], commit: entries[3] })).rejects.toThrow("injected crash");
        if (stored.has("commit")) expect([...stored.keys()].sort()).toEqual(["blob", "chunk", "commit", "tree"]);
      }
    }
  });

  it("resumes an interrupted multi-Chunk bootstrap and publishes its single Commit last", async () => {
    const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
    const captures = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])].map((bytes) => ({
      bytes,
      hash: sha256Hex(bytes),
      size: bytes.byteLength,
    }));
    const blobs = captures.map((capture) => buildBlobObject("", repositoryId, capture));
    const built = buildVaultMultiChunkEnvelope({
      prefix: "",
      repositoryId,
      descriptorHash: "a".repeat(64),
      writerId: "123e4567-e89b-42d3-a456-426614174001",
      sequence: "00000000000000000001",
      previousCommitHash: null,
      createdAt: "2026-07-14T00:00:00.000Z",
      kind: "bootstrap",
      clientVersion: "0.1.0",
      mutations: blobs.map((blob, index) => ({
        path: `note-${index}.md`,
        kind: "put" as const,
        blob: { hash: blob.hash, size: blob.bytes.byteLength },
        parents: [],
      })),
    }, 2);
    const envelope = { blobs, configTrees: [], chunks: built.chunks, commit: built.commit };
    const stored = new Map<string, Uint8Array>();
    const completedWrites: string[] = [];
    let interrupt = true;
    const store = {
      list: async () => ({ keys: [...stored.keys()] }),
      head: async (key: string) => ({ size: stored.get(key)?.byteLength ?? 0 }),
      getStream: async (key: string) => {
        const bytes = stored.get(key);
        if (!bytes) throw new Error("missing interrupted object");
        return objectBodyFromBytes(bytes);
      },
      putImmutable: async (key: string, bytes: Uint8Array) => {
        if (stored.has(key)) throw new Error("already exists");
        if (interrupt && key === built.chunks[1].key) {
          interrupt = false;
          throw new Error("injected bootstrap interruption");
        }
        stored.set(key, new Uint8Array(bytes));
        completedWrites.push(key);
      },
    };

    await expect(publishEnvelope(store, envelope)).rejects.toThrow("missing interrupted object");
    expect(stored.has(built.commit.key)).toBe(false);
    await expect(publishEnvelope(store, envelope)).resolves.toBeUndefined();
    expect(stored.has(built.commit.key)).toBe(true);
    expect(completedWrites.at(-1)).toBe(built.commit.key);
    for (const dependency of [...blobs, ...built.chunks]) expect(stored.has(dependency.key)).toBe(true);
  });
});
