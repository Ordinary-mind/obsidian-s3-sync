import { describe, expect, it } from "vitest";
import { publishEnvelope } from "../../core/remote-publish";

describe("immutable envelope publication", () => {
  it("publishes immutable dependencies before Commit and verifies retry conflicts", async () => {
    const stored = new Map<string, Uint8Array>(); const order: string[] = [];
    const store = { list: async () => ({ keys: [] }), head: async () => ({ size: 0 }), get: async (key: string) => stored.get(key)!, putImmutable: async (key: string, bytes: Uint8Array) => { order.push(key); if (stored.has(key)) throw new Error("exists"); stored.set(key, new Uint8Array(bytes)); } };
    const object = (key: string) => ({ key, hash: key, bytes: new Uint8Array([1]) });
    await publishEnvelope(store, { blobs: [object("blob")], configTrees: [object("tree")], chunks: [object("chunk")], commit: object("commit") });
    expect(order).toEqual(["blob", "tree", "chunk", "commit"]);
    await expect(publishEnvelope(store, { blobs: [object("blob")], configTrees: [], chunks: [], commit: object("commit") })).resolves.toBeUndefined();
  });
});
