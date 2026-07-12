import { describe, expect, it } from "vitest";
import { isConfigPathExcluded, isHistoricalConfigCompatible, isVaultPathExcluded } from "../../core/scope";

describe("Vault protocol scope", () => {
  it("permanently excludes current and historical config roots", () => {
    expect(isVaultPathExcluded(".obsidian/plugins/x/main.js", ".obsidian", ["old-config"])).toBe(true);
    expect(isVaultPathExcluded("old-config/token.json", ".obsidian", ["old-config"])).toBe(true);
    expect(isVaultPathExcluded("notes/a.md", ".obsidian", ["old-config"])).toBe(false);
  });
  it("permanently excludes plugin state and the sync plugin from Config scope", () => {
    expect(isConfigPathExcluded("plugins/obsidian-s3-sync/data.json")).toBe(true);
    expect(isConfigPathExcluded(".obsidian-s3-sync-local/repository/state.json")).toBe(true);
    expect(isConfigPathExcluded("plugins/other/manifest.json")).toBe(false);
  });
  it("blocks joining when local historical roots are absent from the Descriptor", () => {
    expect(isHistoricalConfigCompatible(["old"], ["old", "older"])).toBe(true);
    expect(isHistoricalConfigCompatible(["local-only"], ["old"])).toBe(false);
  });
});
