import { describe, expect, it } from "vitest";
import {
  assertPluginDataContainsNoOperationalState,
  effectivePersistedRepositoryPrefix,
  plaintextCredentialWarning,
} from "../../core/plugin-data";

describe("plugin data boundary", () => {
  it("allows connection and UI preferences but rejects causal state in data.json", () => {
    expect(() => assertPluginDataContainsNoOperationalState({ schemaVersion: 2, connection: { endpoint: "https://s3.example.com" }, preferences: { autoSync: false } })).not.toThrow();
    expect(() => assertPluginDataContainsNoOperationalState({ settings: {}, syncData: { outbox: [] } })).toThrow("syncData.outbox");
    expect(() => assertPluginDataContainsNoOperationalState({ schemaVersion: 2, preferences: { v1DurableOutbox: [] } })).toThrow("v1DurableOutbox");
    expect(() => assertPluginDataContainsNoOperationalState({ schemaVersion: 2, connection: {}, preferences: {}, unexpected: true })).toThrow("unexpected");
  });

  it("explicitly warns when credentials are persisted without a secret provider", () => {
    expect(plaintextCredentialWarning({ kind: "plaintext", accessKeyId: "id", secretAccessKey: "secret" })).toContain("明文");
    expect(plaintextCredentialWarning({ kind: "secret-provider", reference: "keychain:one" })).toBeUndefined();
  });

  it("keeps the confirmed Prefix after the Vault fallback name changes", () => {
    expect(effectivePersistedRepositoryPrefix("confirmed/prefix", "from-renamed-vault")).toBe("confirmed/prefix");
    expect(effectivePersistedRepositoryPrefix(undefined, "from-current-vault")).toBe("from-current-vault");
  });
});
