import { describe, expect, it } from "vitest";
import { createRepositoryDescriptor } from "../../core/repository-bootstrap";
import { objectBodyFromBytes } from "../../core/object-store";

describe("repository bootstrap", () => {
  it("creates one canonical immutable descriptor at its exact repository key", async () => {
    const objects = new Map<string, Uint8Array>();
    const store = {
      list: async () => ({ keys: [] }),
      head: async () => ({ size: 0 }),
      getStream: async (key: string) => objectBodyFromBytes(objects.get(key) ?? new Uint8Array()),
      putImmutable: async (key: string, bytes: Uint8Array) => {
        const current = objects.get(key);
        if (current && !current.every((value, index) => value === bytes[index])) throw new Error("immutable collision");
        objects.set(key, bytes);
      },
    };
    const result = await createRepositoryDescriptor(store, {
      prefix: "vault-a",
      repositoryId: "123e4567-e89b-42d3-a456-426614174000",
      configDir: ".obsidian",
      historicalConfigDirs: [],
    });

    expect(result).toMatchObject({
      repositoryId: "123e4567-e89b-42d3-a456-426614174000",
      key: "vault-a/.obsidian-s3-sync/v1/repositories/123e4567-e89b-42d3-a456-426614174000/format.json",
    });
    expect(result.descriptorHash).toMatch(/^[0-9a-f]{64}$/);
    expect(new TextDecoder().decode(objects.get(result.key))).toContain('"canonicalJson":"RFC8785"');
  });

  it("rejects an invalid descriptor before it reaches ObjectStore", async () => {
    let writes = 0;
    const store = { list: async () => ({ keys: [] }), head: async () => ({ size: 0 }), getStream: async () => objectBodyFromBytes(new Uint8Array()), putImmutable: async () => { writes += 1; } };
    await expect(createRepositoryDescriptor(store, {
      prefix: "",
      repositoryId: "123e4567-e89b-42d3-a456-426614174000",
      configDir: "/invalid",
      historicalConfigDirs: [],
    })).rejects.toThrow();
    expect(writes).toBe(0);
  });
});
