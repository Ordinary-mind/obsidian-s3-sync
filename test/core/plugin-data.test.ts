import { describe, expect, it } from "vitest";
import { assertPluginDataContainsNoOperationalState, plaintextCredentialWarning } from "../../core/plugin-data";

describe("plugin data boundary", () => {
  it("allows connection and UI preferences but rejects causal state in data.json", () => {
    expect(() => assertPluginDataContainsNoOperationalState({ schemaVersion: 2, connection: { endpoint: "https://s3.example.com" }, preferences: { autoSync: false } })).not.toThrow();
    expect(() => assertPluginDataContainsNoOperationalState({ settings: {}, syncData: { outbox: [] } })).toThrow("syncData.outbox");
  });

  it("explicitly warns when credentials are persisted without a secret provider", () => {
    expect(plaintextCredentialWarning({ kind: "plaintext", accessKeyId: "id", secretAccessKey: "secret" })).toContain("明文");
    expect(plaintextCredentialWarning({ kind: "secret-provider", reference: "keychain:one" })).toBeUndefined();
  });
});
