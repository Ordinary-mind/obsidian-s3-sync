import { describe, expect, it } from "vitest";
import { findNfcPathCollisions, normalizeVaultPath, validatePortablePath, validatePortablePluginId, validateRemoteVaultPath, vaultPathCaseFoldKey } from "../../core/path";

describe("Vault path normalization", () => {
  it("uses frozen NFC and rejects unsafe relative-path shapes", () => {
    expect(normalizeVaultPath("notes/e\u0301.md")).toBe("notes/é.md");
    for (const path of ["", "/absolute", "a//b", "a/../b", "a\\b", "a/"]) expect(() => normalizeVaultPath(path)).toThrow("invalid Vault");
  });
  it("uses frozen default case folding for aliases", () => {
    expect(vaultPathCaseFoldKey("Notes/STRASSE.md")).toBe(vaultPathCaseFoldKey("notes/straße.md"));
  });
  it("rejects non-NFC remote paths and reports all local raw-name collisions", () => {
    expect(validateRemoteVaultPath("notes/é.md")).toBe("notes/é.md");
    expect(() => validateRemoteVaultPath("notes/e\u0301.md")).toThrow("must be NFC");
    const paths = ["notes/é.md", "other.md", "notes/e\u0301.md"];
    expect(findNfcPathCollisions(paths)).toEqual([["notes/e\u0301.md", "notes/é.md"]]);
    expect(findNfcPathCollisions([...paths].reverse())).toEqual([["notes/e\u0301.md", "notes/é.md"]]);
    expect(findNfcPathCollisions(paths)[0]).toHaveLength(2);
  });
  it("rejects portable paths Windows cannot represent", () => {
    expect(validatePortablePath("notes/COM1.md")).toContain("windows-reserved-name");
    expect(validatePortablePath("notes/trailing. ")).toContain("windows-trailing-dot-or-space");
    expect(validatePortablePath("notes/bad?.md")).toContain("windows-illegal-character");
    expect(validatePortablePath("notes/control\u0001.md")).toContain("windows-illegal-character");
  });
  it("validates plugin IDs with frozen Unicode and portable segment rules", () => {
    expect(validatePortablePluginId("portable-plugin")).toEqual([]);
    expect(validatePortablePluginId("CON.json")).toContain("windows-reserved-name");
    expect(validatePortablePluginId("e\u0301")).toContain("non-nfc");
    expect(validatePortablePluginId("x".repeat(256))).toContain("plugin-id-length");
  });
});
