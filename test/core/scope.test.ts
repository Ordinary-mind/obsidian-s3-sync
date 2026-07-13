import { describe, expect, it } from "vitest";
import { isConfigPathExcluded, isConfigPathExcludedForRepository, isHistoricalConfigCompatible, isVaultPathExcluded, localStateRoot, planConfigDirBinding, sensitivePathExclusions } from "../../core/scope";

const repositoryId = "123e4567-e89b-42d3-a456-426614174000";

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
  it("excludes historical config roots nested inside the current config root", () => {
    expect(isConfigPathExcluded("legacy/plugins/x/main.js", ".config", [".config/legacy", "old-config"])).toBe(true);
    expect(isConfigPathExcluded("plugins/x/main.js", ".config", [".config/legacy", "old-config"])).toBe(false);
  });
  it("blocks joining when local historical roots are absent from the Descriptor", () => {
    expect(isHistoricalConfigCompatible(["old"], ["old", "older"])).toBe(true);
    expect(isHistoricalConfigCompatible(["local-only"], ["old"])).toBe(false);
  });
  it("uses only fixed repository-scoped sensitive roots", () => {
    expect(localStateRoot(".config", repositoryId)).toBe(`.config/.obsidian-s3-sync-local/${repositoryId}`);
    expect(sensitivePathExclusions(".config", [".obsidian"], repositoryId)).toEqual({
      vault: [".config", ".obsidian", ".s3-sync-conflicts"],
      config: [`.obsidian-s3-sync-local/${repositoryId}`, "plugins/obsidian-s3-sync"],
    });
    expect(isConfigPathExcludedForRepository(`.obsidian-s3-sync-local/${repositoryId}/outbox/state.json`, repositoryId)).toBe(true);
    expect(isConfigPathExcludedForRepository(".obsidian-s3-sync-local/user-file.txt", repositoryId)).toBe(false);
    expect(isConfigPathExcludedForRepository("plugins/OBSIDIAN-S3-SYNC/data.json", repositoryId)).toBe(true);
  });
  it("keeps plugin data, state, and previous config roots excluded with a custom configDir", () => {
    expect(isVaultPathExcluded(".custom/plugins/obsidian-s3-sync/data.json", ".custom", [])).toBe(true);
    expect(isVaultPathExcluded(`.custom/.obsidian-s3-sync-local/${repositoryId}/outbox/state.json`, ".custom", [])).toBe(true);
    expect(sensitivePathExclusions(".new-config", [".custom", ".older"], repositoryId).vault).toEqual([
      ".new-config",
      ".custom",
      ".older",
      ".s3-sync-conflicts",
    ]);
  });
  it("requires a new repository generation when configDir identity changes", () => {
    expect(planConfigDirBinding({ descriptorConfigDir: ".old", descriptorHistoricalConfigDirs: [".older"], actualConfigDir: ".new", localHistoricalConfigDirs: [".local-old"] })).toEqual({
      status: "requires-new-generation",
      configDir: ".new",
      historicalConfigDirs: [".old", ".older", ".local-old"],
    });
    expect(planConfigDirBinding({ descriptorConfigDir: ".obsidian", descriptorHistoricalConfigDirs: [".old"], actualConfigDir: ".obsidian", localHistoricalConfigDirs: [".old"] })).toEqual({ status: "match" });
  });
});
