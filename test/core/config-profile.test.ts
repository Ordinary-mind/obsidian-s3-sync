import { describe, expect, it } from "vitest";
import { hasPackageManifestAnchor, isConfigItemCovered, isPortablePluginIdAllowed } from "../../core/config-profile";
import { mergeEnabledPortablePlugins } from "../../core/plugin-enable";

const profile = { baseFiles: ["app.json"], syncThemes: true, syncSnippets: false, portablePluginIds: ["plugin"], pluginPackages: ["plugin"], pluginData: ["plugin"] };
describe("ConfigTree profile coverage", () => {
  it("maps each managed item to its one allowed profile source", () => {
    expect(isConfigItemCovered("app.json", profile)).toBe(true);
    expect(isConfigItemCovered("themes/a.css", profile)).toBe(true);
    expect(isConfigItemCovered("plugins/plugin/main.js", profile)).toBe(true);
    expect(isConfigItemCovered("plugins/plugin/data.json", profile)).toBe(true);
    expect(isConfigItemCovered("workspace.json", profile)).toBe(false);
  });
  it("requires a manifest anchor for every synced package and preserves unmanaged enablement", () => {
    expect(hasPackageManifestAnchor([{ path: "plugins/plugin/main.js", kind: "put" }], profile)).toBe(false);
    expect(hasPackageManifestAnchor([{ path: "plugins/plugin/main.js", kind: "put" }, { path: "plugins/plugin/manifest.json", kind: "put" }], profile)).toBe(true);
    expect(mergeEnabledPortablePlugins(["plugin"], ["local"], "obsidian-s3-sync")).toEqual(["local", "obsidian-s3-sync", "plugin"]);
  });
  it("rejects the sync plugin and invalid portable plugin IDs", () => {
    expect(isPortablePluginIdAllowed("other", "obsidian-s3-sync")).toBe(true);
    expect(isPortablePluginIdAllowed("obsidian-s3-sync", "obsidian-s3-sync")).toBe(false);
    expect(isPortablePluginIdAllowed("OBSIDIAN-S3-SYNC", "obsidian-s3-sync")).toBe(false);
    expect(isPortablePluginIdAllowed("bad/name", "obsidian-s3-sync")).toBe(false);
    expect(isPortablePluginIdAllowed("NUL.json", "obsidian-s3-sync")).toBe(false);
  });
});
