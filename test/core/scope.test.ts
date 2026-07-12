import { describe, expect, it } from "vitest";
import { isVaultPathExcluded } from "../../core/scope";

describe("Vault protocol scope", () => {
  it("permanently excludes current and historical config roots", () => {
    expect(isVaultPathExcluded(".obsidian/plugins/x/main.js", ".obsidian", ["old-config"])).toBe(true);
    expect(isVaultPathExcluded("old-config/token.json", ".obsidian", ["old-config"])).toBe(true);
    expect(isVaultPathExcluded("notes/a.md", ".obsidian", ["old-config"])).toBe(false);
  });
});
