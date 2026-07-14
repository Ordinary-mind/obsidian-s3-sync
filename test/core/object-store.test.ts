import { describe, expect, it } from "vitest";
import { canWriteAfterProbe, hashObjectStream, objectBodyFromBytes, readObjectBytes, verifyObjectStream } from "../../core/object-store";

describe("ObjectStore write capability", () => {
  it("does not permit protocol writes without proven atomic create", () => {
    expect(canWriteAfterProbe(false)).toBe(false);
    expect(canWriteAfterProbe(true)).toBe(true);
  });
});

describe("ObjectStore streaming Get", () => {
  it("combines chunks and rejects a body over its declared limit", async () => {
    const store = { getStream: async () => objectBodyFromBytes(new Uint8Array([1, 2, 3])) };
    await expect(readObjectBytes(store, "key", { maximumBytes: 3 })).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(readObjectBytes(store, "key", { maximumBytes: 2 })).rejects.toMatchObject({ kind: "integrity", operation: "get" });
  });
  it("verifies SHA-256 incrementally while consuming chunks", async () => {
    const store = { getStream: async () => objectBodyFromBytes(new Uint8Array([1, 2, 3])) };
    await expect(readObjectBytes(store, "key", { expectedHash: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81" })).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(readObjectBytes(store, "key", { expectedHash: "a".repeat(64) })).rejects.toMatchObject({ kind: "integrity", operation: "get", details: { stage: "hash" } });
  });

  it("verifies Hash and exact size without materializing a contiguous result", async () => {
    const chunks = [new Uint8Array([1]), new Uint8Array([2, 3])];
    const store = { getStream: async () => stream(chunks) };
    await expect(verifyObjectStream(store, "key", {
      hash: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
      size: 3,
    })).resolves.toBeUndefined();
    await expect(verifyObjectStream(store, "key", { hash: "a".repeat(64), size: 3 }))
      .rejects.toMatchObject({ kind: "integrity", details: { stage: "hash" } });
  });

  it("stops streaming Hash work after cancellation", async () => {
    const controller = new AbortController();
    async function* body(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1]);
      controller.abort();
      yield new Uint8Array([2]);
    }
    await expect(hashObjectStream(body(), { signal: controller.signal }))
      .rejects.toMatchObject({ kind: "cancelled", operation: "get" });
  });
});

async function* stream(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}
