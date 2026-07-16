import { describe, expect, it } from "vitest";
import {
  assertPluginDataContainsNoOperationalState,
  effectivePersistedRepositoryPrefix,
  plaintextCredentialWarning,
} from "../../core/plugin-data";
import { createDefaultConfigProfile } from "../../core/config-profile";

describe("plugin data boundary", () => {
  it("allows connection and UI preferences but rejects causal state in data.json", () => {
    expect(() => assertPluginDataContainsNoOperationalState({ schemaVersion: 3, connection: { endpoint: "https://s3.example.com" }, preferences: { autoSync: false } })).not.toThrow();
    expect(() => assertPluginDataContainsNoOperationalState({
      schemaVersion: 3,
      connection: {},
      preferences: { configProfile: createDefaultConfigProfile("1.7.7") },
    })).not.toThrow();
    expect(() => assertPluginDataContainsNoOperationalState({ settings: {}, syncData: { outbox: [] } })).toThrow("syncData.outbox");
    expect(() => assertPluginDataContainsNoOperationalState({ schemaVersion: 3, preferences: { v1DurableOutbox: [] } })).toThrow("v1DurableOutbox");
    expect(() => assertPluginDataContainsNoOperationalState({ schemaVersion: 3, preferences: { baseFiles: [] }, connection: {} })).not.toThrow();
    expect(() => assertPluginDataContainsNoOperationalState({ schemaVersion: 3, connection: {}, preferences: {}, unexpected: true })).toThrow("unexpected");
  });

  it("explicitly warns when credentials are persisted without a secret provider", () => {
    expect(plaintextCredentialWarning()).toContain("明文");
  });

  it("keeps the confirmed Prefix after the Vault fallback name changes", () => {
    expect(effectivePersistedRepositoryPrefix("confirmed/prefix", "from-renamed-vault")).toBe("confirmed/prefix");
    expect(effectivePersistedRepositoryPrefix(undefined, "from-current-vault")).toBe("from-current-vault");
  });
});
