import { describe, expect, it } from "vitest";
import { createDefaultConfigProfile } from "../../core/config-profile";
import type { ObjectStore } from "../../core/object-store";
import { V1RepositoryService } from "../../src/v1-service";

describe("V1 repository service", () => {
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
