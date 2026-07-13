import { describe, expect, it } from "vitest";
import { publishEnvelope } from "../../core/remote-publish";
import { objectBodyFromBytes } from "../../core/object-store";

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
});
