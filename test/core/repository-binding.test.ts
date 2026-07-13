import { describe, expect, it } from "vitest";
import { createRepositoryLocator } from "../../core/locator";
import { assertDescriptorDirectoryBinding, assertPersistedRepositoryBinding, createPersistedRepositoryBinding } from "../../core/repository-binding";

describe("persisted repository binding", () => {
  const locator = createRepositoryLocator({ endpoint: "https://s3.example.com", region: "test", bucket: "vault", forcePathStyle: true, prefix: "team" });
  const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
  const descriptorHash = "a".repeat(64);

  it("binds the complete Locator and local config identity", () => {
    const binding = createPersistedRepositoryBinding(locator, repositoryId, descriptorHash, ".obsidian", [".old"]);
    expect(() => assertPersistedRepositoryBinding(binding, locator, ".obsidian", [".old"])).not.toThrow();
    const changed = createRepositoryLocator({ ...locator, prefix: "other" });
    expect(() => assertPersistedRepositoryBinding(binding, changed, ".obsidian", [".old"])).toThrow("RepositoryLocator changed");
    expect(() => assertPersistedRepositoryBinding({ ...binding, locator: { ...binding.locator, bucket: "other" } }, locator, ".obsidian", [".old"])).toThrow("RepositoryLocator changed");
    expect(() => assertPersistedRepositoryBinding(binding, locator, ".config", [".old"])).toThrow("vault.configDir changed");
    expect(() => assertPersistedRepositoryBinding(binding, locator, ".obsidian", [".unknown"])).toThrow("historical configDir");
  });

  it("rejects persisted directory fields that differ from the verified Descriptor", () => {
    const binding = createPersistedRepositoryBinding(locator, repositoryId, descriptorHash, ".obsidian", [".old"]);
    expect(() => assertDescriptorDirectoryBinding(binding, { configDir: ".obsidian", historicalConfigDirs: [".old"] })).not.toThrow();
    expect(() => assertDescriptorDirectoryBinding(binding, { configDir: ".obsidian", historicalConfigDirs: [] })).toThrow("directory binding changed");
  });
});
