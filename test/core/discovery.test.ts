import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { discoverRepositoryDescriptors } from "../../core/discovery";

describe("repository discovery", () => {
  it("accepts only exact format.json candidates and verifies each body", async () => {
    const vector = JSON.parse(readFileSync(new URL("../../protocol/vectors/repository-descriptor-basic.json", import.meta.url), "utf8"));
    const key = vector.key;
    const body = new TextEncoder().encode(vector.canonicalJson);
    const store = { list: async () => ({ keys: [key, `${key}/extra`] }), get: async () => body, head: async () => ({ size: body.byteLength }), putImmutable: async () => undefined };
    await expect(discoverRepositoryDescriptors(store, "")).resolves.toHaveLength(1);
  });
  it("stops a malformed repeated continuation token instead of looping forever", async () => {
    const store = { list: async () => ({ keys: [], continuationToken: "repeat" }), get: async () => new Uint8Array(), head: async () => ({ size: 0 }), putImmutable: async () => undefined };
    await expect(discoverRepositoryDescriptors(store, "")).rejects.toThrow("repeated continuation token");
  });
});
