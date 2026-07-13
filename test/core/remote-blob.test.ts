import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../protocol/hash";
import { blobKey } from "../../protocol/keys";
import { downloadVerifiedBlob } from "../../core/remote-blob";

describe("remote Blob download", () => {
  it("requires both declared size and content address hash", async () => {
    const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
    const bytes = new Uint8Array([1, 2]);
    const hash = sha256Hex(bytes);
    const key = blobKey("", repositoryId, hash);
    const store = { get: async (requested: string) => { if (requested !== key) throw new Error("unexpected key"); return bytes; }, list: async () => ({ keys: [] }), head: async () => ({ size: 2 }), putImmutable: async () => undefined };
    await expect(downloadVerifiedBlob(store, "", repositoryId, { hash, size: 2 })).resolves.toEqual(bytes);
    await expect(downloadVerifiedBlob(store, "", repositoryId, { hash, size: 3 })).rejects.toThrow("size differs");
  });
});
