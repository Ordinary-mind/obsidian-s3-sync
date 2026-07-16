import { describe, expect, it } from "vitest";
import { createDefaultConfigProfile, hasPackageManifestAnchor, isConfigItemCovered, isPortablePluginIdAllowed, validateConfigProfile } from "../../core/config-profile";

const profile = { baseFiles: ["app.json"], syncThemes: true, syncSnippets: false, portablePluginIds: ["plugin"], pluginPackages: ["plugin"], pluginData: ["plugin"] };
describe("ConfigTree profile coverage", () => {
  it("maps each managed item to its one allowed profile source", () => {
    expect(isConfigItemCovered("app.json", profile)).toBe(true);
    expect(isConfigItemCovered("themes/a.css", profile)).toBe(true);
    expect(isConfigItemCovered("plugins/plugin/main.js", profile)).toBe(true);
    expect(isConfigItemCovered("plugins/plugin/data.json", profile)).toBe(true);
    expect(isConfigItemCovered("workspace.json", profile)).toBe(false);
  });
  it("requires a manifest anchor for every synced package", () => {
    expect(hasPackageManifestAnchor([{ path: "plugins/plugin/main.js", kind: "put" }], profile)).toBe(false);
    expect(hasPackageManifestAnchor([{ path: "plugins/plugin/main.js", kind: "put" }, { path: "plugins/plugin/manifest.json", kind: "put" }], profile)).toBe(true);
  });
  it("rejects the sync plugin and invalid portable plugin IDs", () => {
    expect(isPortablePluginIdAllowed("other", "obsidian-s3-sync")).toBe(true);
    expect(isPortablePluginIdAllowed("obsidian-s3-sync", "obsidian-s3-sync")).toBe(false);
    expect(isPortablePluginIdAllowed("OBSIDIAN-S3-SYNC", "obsidian-s3-sync")).toBe(false);
    expect(isPortablePluginIdAllowed("bad/name", "obsidian-s3-sync")).toBe(false);
    expect(isPortablePluginIdAllowed("NUL.json", "obsidian-s3-sync")).toBe(false);
  });
  it("uses the three frozen defaults and rejects raw enable/core/workspace files", () => {
    expect(createDefaultConfigProfile("1.8.0").baseFiles).toEqual(["app.json", "appearance.json", "hotkeys.json"]);
    expect(validateConfigProfile({ ...createDefaultConfigProfile("1.8.0"), baseFiles: ["community-plugins.json"] })).toContain("forbidden-base-file");
    expect(validateConfigProfile({ ...createDefaultConfigProfile("1.8.0"), baseFiles: ["core-plugins.json"] })).toContain("forbidden-base-file");
    expect(validateConfigProfile({ ...createDefaultConfigProfile("1.8.0"), baseFiles: ["workspace-mobile.json"] })).toContain("forbidden-base-file");
    expect(validateConfigProfile({ ...createDefaultConfigProfile("1.8.0"), baseFiles: ["hotkeys.json", "app.json"] })).toContain("base-files-not-canonical");
    expect(validateConfigProfile({ ...createDefaultConfigProfile("1.8.0"), portablePluginIds: ["z", "a"] })).toContain("portable-plugins-not-canonical");
  });
});
