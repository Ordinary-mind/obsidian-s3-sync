import { describe, expect, it } from "vitest";
import { normalizeVaultPath, vaultPathCaseFoldKey } from "../../core/path";

describe("Vault path normalization", () => {
  it("uses frozen NFC and rejects unsafe relative-path shapes", () => {
    expect(normalizeVaultPath("notes/e\u0301.md")).toBe("notes/é.md");
    for (const path of ["", "/absolute", "a//b", "a/../b", "a\\b", "a/"]) expect(() => normalizeVaultPath(path)).toThrow("invalid Vault");
  });
  it("uses frozen default case folding for aliases", () => {
    expect(vaultPathCaseFoldKey("Notes/STRASSE.md")).toBe(vaultPathCaseFoldKey("notes/straße.md"));
  });
});
