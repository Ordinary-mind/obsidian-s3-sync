import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { discoverRepositoryDescriptors, discoverRepositoryDescriptorsWithDiagnostics } from "../../core/discovery";
import { objectBodyFromBytes } from "../../core/object-store";

describe("repository discovery", () => {
  it("accepts only exact format.json candidates and verifies each body", async () => {
    const vector = JSON.parse(readFileSync(new URL("../../protocol/vectors/repository-descriptor-basic.json", import.meta.url), "utf8"));
    const key = vector.key;
    const body = new TextEncoder().encode(vector.canonicalJson);
    const store = { list: async () => ({ keys: [key, `${key}/extra`] }), getStream: async () => objectBodyFromBytes(body), head: async () => ({ size: body.byteLength }), putImmutable: async () => undefined };
    await expect(discoverRepositoryDescriptors(store, "")).resolves.toHaveLength(1);
  });
  it("stops a malformed repeated continuation token instead of looping forever", async () => {
    const store = { list: async () => ({ keys: [], continuationToken: "repeat" }), getStream: async () => objectBodyFromBytes(new Uint8Array()), head: async () => ({ size: 0 }), putImmutable: async () => undefined };
    await expect(discoverRepositoryDescriptors(store, "")).rejects.toThrow("repeated continuation token");
  });
  it("isolates malformed UUID and unreadable candidates while retaining valid repositories", async () => {
    const vector = JSON.parse(readFileSync(new URL("../../protocol/vectors/repository-descriptor-basic.json", import.meta.url), "utf8"));
    const validKey = vector.key as string;
    const invalidUuidKey = validKey.replace(vector.object.repositoryId, "123e4567-e89b-12d3-a456-426614174000");
    const missingKey = validKey.replace(vector.object.repositoryId, "123e4567-e89b-42d3-a456-426614174001");
    const body = new TextEncoder().encode(vector.canonicalJson);
    const store = {
      list: async () => ({ keys: [invalidUuidKey, missingKey, validKey] }),
      getStream: async (key: string) => {
        if (key === missingKey) throw new Error("temporary 404");
        return objectBodyFromBytes(body);
      },
      head: async () => ({ size: body.byteLength }),
      putImmutable: async () => undefined,
    };
    await expect(discoverRepositoryDescriptorsWithDiagnostics(store, "")).resolves.toMatchObject({
      repositories: [{ key: validKey }],
      diagnostics: expect.arrayContaining([
        { key: invalidUuidKey, stage: "candidate" },
        { key: missingKey, stage: "read-or-verify" },
      ]),
    });
  });
});
