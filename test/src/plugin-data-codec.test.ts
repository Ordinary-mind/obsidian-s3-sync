import { describe, expect, it } from "vitest";
import { createDefaultConfigProfile } from "../../core/config-profile";
import { createPersistedRepositoryBinding } from "../../core/repository-binding";
import { createRepositoryLocator } from "../../core/locator";
import { decodePluginData, encodePluginData } from "../../src/plugin-data-codec";
import type { S3SyncSettings } from "../../src/types";

const settings: S3SyncSettings = {
  endpoint: "https://s3.example.com",
  region: "test",
  bucket: "vault",
  accessKeyId: "id",
  secretAccessKey: "secret",
  prefix: "team",
  forcePathStyle: true,
  autoSync: false,
  ignoredPatterns: ".trash/**",
  configProfile: createDefaultConfigProfile("1.8.0"),
};

describe("strict plugin data codec", () => {
  it("round-trips the one supported schema without defaults or duplicate runtime Prefix", () => {
    const locator = createRepositoryLocator({ ...settings, prefix: settings.prefix });
    const selection = createPersistedRepositoryBinding(
      locator,
      "123e4567-e89b-42d3-a456-426614174000",
      "a".repeat(64),
      ".obsidian",
      [],
    );
    const encoded = encodePluginData(settings, selection);

    expect(decodePluginData(encoded)).toEqual({ settings, repositorySelection: selection });
    expect(encoded.repositorySelection?.prefix).toBe(locator.normalizedPrefix);
  });

  it("rejects unsupported, partial, unknown, and identity-inconsistent data", () => {
    const encoded = encodePluginData(settings);
    expect(() => decodePluginData({ ...encoded, schemaVersion: 1 })).toThrowError(expect.objectContaining({ code: "PLUGIN_DATA_SCHEMA_VERSION" }));
    expect(() => decodePluginData({ ...encoded, connection: { endpoint: settings.endpoint } })).toThrow("plugin data failed strict validation");
    expect(() => decodePluginData({ ...encoded, unexpected: true })).toThrow("plugin data failed strict validation");

    const locator = createRepositoryLocator({ ...settings, prefix: settings.prefix });
    const selection = createPersistedRepositoryBinding(locator, "repo", "b".repeat(64), ".obsidian", []);
    const selected = encodePluginData(settings, selection);
    expect(() => decodePluginData({
      ...selected,
      repositorySelection: { ...selected.repositorySelection, prefix: "other" },
    })).toThrow("plugin data failed strict validation");
  });
});
