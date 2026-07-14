import { describe, expect, it } from "vitest";
import { createRepositoryDescriptor, readRepositoryDescriptorAnchor } from "../../core/repository-bootstrap";
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
    const directOnly = {
      getStream: async (key: string) => objectBodyFromBytes(objects.get(key) ?? new TextEncoder().encode("missing")),
      list: async () => { throw new Error("List must not be used for a persisted anchor"); },
    };
    await expect(readRepositoryDescriptorAnchor(directOnly, "vault-a", result.repositoryId, result.descriptorHash)).resolves.toEqual({ configDir: ".obsidian", historicalConfigDirs: [] });
    await expect(readRepositoryDescriptorAnchor(directOnly, "vault-a", result.repositoryId, "a".repeat(64))).rejects.toMatchObject({ kind: "integrity" });
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
    await expect(createRepositoryDescriptor(store, {
      prefix: "",
      repositoryId: "123e4567-e89b-42d3-a456-426614174000",
      configDir: ".obsidian",
      historicalConfigDirs: [".s3-sync-conflicts/legacy"],
    })).rejects.toThrow("conflict root");
    expect(writes).toBe(0);
  });

  it("canonicalizes directory history and makes concurrent creation idempotent per repositoryId", async () => {
    const objects = new Map<string, Uint8Array>();
    const store = {
      list: async () => ({ keys: [...objects.keys()] }),
      head: async (key: string) => ({ size: objects.get(key)?.byteLength ?? 0 }),
      getStream: async (key: string) => objectBodyFromBytes(objects.get(key) ?? new Uint8Array()),
      putImmutable: async (key: string, bytes: Uint8Array) => {
        await Promise.resolve();
        const current = objects.get(key);
        if (current && (current.byteLength !== bytes.byteLength || !current.every((value, index) => value === bytes[index]))) {
          throw new Error("immutable collision");
        }
        objects.set(key, new Uint8Array(bytes));
      },
    };
    const base = {
      prefix: "vault-a",
      configDir: ".obsidian",
      historicalConfigDirs: [".old", ".legacy"],
    };
    const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
    const same = await Promise.all([
      createRepositoryDescriptor(store, { ...base, repositoryId }),
      createRepositoryDescriptor(store, { ...base, repositoryId }),
    ]);
    expect(same[0]).toEqual(same[1]);
    expect(JSON.parse(new TextDecoder().decode(objects.get(same[0].key))).historicalConfigDirs).toEqual([".legacy", ".old"]);

    const otherId = "123e4567-e89b-42d3-a456-426614174001";
    const other = await createRepositoryDescriptor(store, { ...base, repositoryId: otherId });
    expect(other.key).not.toBe(same[0].key);
    expect(objects.size).toBe(2);
  });
});
