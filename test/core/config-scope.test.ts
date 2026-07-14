import { describe, expect, it } from "vitest";
import { classifyConfigVaultPath, configRelativePath, portableConfigPaths } from "../../core/config-scope";
import { createDefaultConfigProfile } from "../../core/config-profile";

describe("actual configDir portable scope", () => {
  const profile = { ...createDefaultConfigProfile("1.8.0"), syncThemes: true };

  it("derives paths from the actual custom configDir and never includes core/workspace state", () => {
    expect(configRelativePath("settings", "settings/app.json")).toBe("app.json");
    expect(() => configRelativePath("settings", ".obsidian/app.json")).toThrow("outside");
    expect(portableConfigPaths({ actualConfigDir: "settings", historicalConfigDirs: [], profile, vaultPaths: [
      "settings/app.json", "settings/core-plugins.json", "settings/workspace-mobile.json", "settings/themes/a/theme.css",
    ] })).toEqual(["app.json", "themes/a/theme.css"]);
  });

  it("excludes a historical root inside current but does not let an ancestor history hide current", () => {
    expect(classifyConfigVaultPath({ actualConfigDir: "settings", historicalConfigDirs: ["settings/legacy"], vaultPath: "settings/legacy/app.json", profile })).toBe("excluded");
    expect(classifyConfigVaultPath({ actualConfigDir: "settings/current", historicalConfigDirs: ["settings"], vaultPath: "settings/current/app.json", profile })).toBe("portable-item");
    expect(classifyConfigVaultPath({ actualConfigDir: "settings", historicalConfigDirs: ["old-settings"], vaultPath: "settings/app.json", profile })).toBe("portable-item");
  });

  it("handles community enablement structurally instead of as a raw base file", () => {
    expect(classifyConfigVaultPath({ actualConfigDir: "settings", historicalConfigDirs: [], vaultPath: "settings/community-plugins.json", profile })).toBe("community-enable-list");
  });

  it("keeps device-local plugin packages, data, and core state outside the portable item set", () => {
    const plugins = { ...profile, portablePluginIds: ["portable"], pluginPackages: ["portable"] };
    expect(portableConfigPaths({
      actualConfigDir: "settings",
      historicalConfigDirs: [],
      profile: plugins,
      vaultPaths: [
        "settings/plugins/portable/manifest.json",
        "settings/plugins/portable/data.json",
        "settings/plugins/device-only/main.js",
        "settings/plugins/device-only/data.json",
        "settings/core-plugins.json",
      ],
    })).toEqual(["plugins/portable/manifest.json"]);
  });

  it("permanently excludes credentials, plugin code and repository state under a custom configDir", () => {
    expect(portableConfigPaths({
      actualConfigDir: ".custom",
      historicalConfigDirs: [".obsidian"],
      profile: { ...profile, syncThemes: true, portablePluginIds: ["obsidian-s3-sync"], pluginPackages: ["obsidian-s3-sync"], pluginData: ["obsidian-s3-sync"] },
      vaultPaths: [
        ".custom/plugins/obsidian-s3-sync/main.js",
        ".custom/plugins/obsidian-s3-sync/data.json",
        ".custom/.obsidian-s3-sync-local/repository/state-a.json",
        ".obsidian/plugins/obsidian-s3-sync/data.json",
        ".custom/themes/safe/theme.css",
      ],
    })).toEqual(["themes/safe/theme.css"]);
  });
});
