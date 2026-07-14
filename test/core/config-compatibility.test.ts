import { describe, expect, it } from "vitest";
import { assessConfigTreeCompatibility, detectSensitivePluginData } from "../../core/config-compatibility";
import { createDefaultConfigProfile } from "../../core/config-profile";

describe("portable ConfigTree compatibility", () => {
  const manifest = new TextEncoder().encode('{"id":"p","version":"1.0.0","minAppVersion":"1.5.0"}');

  it("accepts complete package resources, keeps data opt-in separate, and reports code/new-plugin risk", () => {
    const tree = {
      profile: { ...createDefaultConfigProfile("1.8.0"), portablePluginIds: ["p"], pluginPackages: ["p"] },
      enabledCommunityPlugins: ["p"],
      items: [
        { path: "plugins/p/manifest.json", kind: "put" as const, hash: "a", size: manifest.byteLength, stagedRef: "manifest" },
        { path: "plugins/p/main.js", kind: "put" as const, hash: "b", size: 1, stagedRef: "main" },
        { path: "plugins/p/assets/icon.svg", kind: "put" as const, hash: "c", size: 1, stagedRef: "asset" },
      ],
    };
    expect(assessConfigTreeCompatibility({ tree, currentAppVersion: "1.8.0", isDesktop: true, syncPluginId: "obsidian-s3-sync", stagedManifestBytes: new Map([["plugins/p/manifest.json", manifest]]), localPluginManifests: new Map() }))
      .toMatchObject({ status: "compatible", requiresHighRiskConfirmation: true, risks: expect.arrayContaining([expect.objectContaining({ kind: "plugin-code" }), expect.objectContaining({ kind: "new-plugin" })]) });
    expect(tree.items.some((item) => item.path.endsWith("data.json"))).toBe(false);
  });

  it("blocks the whole Tree for missing manifests, app version, desktop-only, or local aliases", () => {
    const profile = { ...createDefaultConfigProfile("2.0.0"), portablePluginIds: ["p"], pluginPackages: ["p"] };
    const tree = { profile, enabledCommunityPlugins: ["p"], items: [{ path: "plugins/p/main.js", kind: "put" as const, hash: "a", size: 1, stagedRef: "a" }] };
    const result = assessConfigTreeCompatibility({ tree, currentAppVersion: "1.9.0", isDesktop: false, syncPluginId: "obsidian-s3-sync", stagedManifestBytes: new Map(), localPluginManifests: new Map(), localPluginDirectories: ["P"], localEnabledPluginIds: ["P"] });
    expect(result.status).toBe("incompatible");
    if (result.status === "incompatible") expect(result.reasons.join(" ")).toMatch(/below|manifest|aliases/);
  });

  it("does not require device-local plugins omitted from the portable Tree", () => {
    const tree = { profile: createDefaultConfigProfile("1.8.0"), enabledCommunityPlugins: [], items: [] };
    expect(assessConfigTreeCompatibility({ tree, currentAppVersion: "1.8.0", isDesktop: false, syncPluginId: "obsidian-s3-sync", stagedManifestBytes: new Map(), localPluginManifests: new Map([["device-only", { id: "device-only", version: "1.0.0" }]]) }))
      .toMatchObject({ status: "compatible", risks: [] });
  });

  it("warns that plugin data sensitivity detection is heuristic and plaintext", () => {
    expect(detectSensitivePluginData(new TextEncoder().encode('{"apiToken":"value"}'))).toMatchObject({ indicators: ["token"], limitation: expect.stringContaining("漏报") });
  });

  it("rejects desktop-only portable packages even on desktop and cannot enable a managed deleted package", () => {
    const profile = { ...createDefaultConfigProfile("1.8.0"), portablePluginIds: ["p"], pluginPackages: ["p"] };
    const desktopManifest = new TextEncoder().encode('{"id":"p","version":"1.0.0","minAppVersion":"1.5.0","isDesktopOnly":true}');
    const desktopTree = {
      profile,
      enabledCommunityPlugins: ["p"],
      items: [{ path: "plugins/p/manifest.json", kind: "put" as const, hash: "a", size: desktopManifest.byteLength, stagedRef: "manifest" }],
    };
    expect(assessConfigTreeCompatibility({ tree: desktopTree, currentAppVersion: "1.8.0", isDesktop: true, syncPluginId: "obsidian-s3-sync", stagedManifestBytes: new Map([["plugins/p/manifest.json", desktopManifest]]), localPluginManifests: new Map() }))
      .toMatchObject({ status: "incompatible", reasons: expect.arrayContaining([expect.stringContaining("incompatible")]) });

    const deletedTree = { profile, enabledCommunityPlugins: ["p"], items: [{ path: "plugins/p/manifest.json", kind: "delete" as const }] };
    expect(assessConfigTreeCompatibility({ tree: deletedTree, currentAppVersion: "1.8.0", isDesktop: true, syncPluginId: "obsidian-s3-sync", stagedManifestBytes: new Map(), localPluginManifests: new Map([["p", { id: "p", version: "1.0.0", minAppVersion: "1.0.0" }]]) }))
      .toMatchObject({ status: "incompatible", reasons: expect.arrayContaining([expect.stringContaining("no package put")]) });
  });
});
