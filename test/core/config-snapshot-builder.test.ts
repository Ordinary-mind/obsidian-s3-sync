import { describe, expect, it } from "vitest";
import { createDefaultConfigProfile } from "../../core/config-profile";
import { buildManagedConfigSnapshot, configProfileTransition, materializeProtocolConfigTree, type ManagedConfigItem } from "../../core/config-snapshot-builder";
import { portableEnabledPluginIds } from "../../core/community-plugins";
import { buildConfigTreeObject } from "../../core/config-tree";

describe("managed ConfigTree snapshot builder", () => {
  const profile = createDefaultConfigProfile("1.8.0");

  it("keeps explicit deletes, requires direct absence evidence for projected puts, and stages second-scan bytes", () => {
    const previous: ManagedConfigItem[] = [
      { path: "app.json", kind: "put", hash: "a", size: 1, stagedRef: "old" },
      { path: "hotkeys.json", kind: "delete" },
      { path: "appearance.json", kind: "put", hash: "b", size: 1, stagedRef: "old-b" },
    ];
    const scan = { status: "captured" as const, scopeRevision: "scope", items: [{ path: "app.json", hash: "new", size: 2, stagedRef: "second-scan" }] };
    expect(buildManagedConfigSnapshot({ profile, scan, previousItems: previous, confirmedAbsentPaths: new Set(["appearance.json"]) })).toMatchObject({
      status: "built",
      items: [
        { path: "app.json", kind: "put", hash: "new", stagedRef: "second-scan" },
        { path: "appearance.json", kind: "delete" },
        { path: "hotkeys.json", kind: "delete" },
      ],
    });
    expect(buildManagedConfigSnapshot({ profile, scan, previousItems: previous, confirmedAbsentPaths: new Set() })).toEqual({
      status: "retry", reason: "missing-not-confirmed", paths: ["appearance.json"],
    });
  });

  it("treats profile removal as stop-managing rather than deletion", () => {
    const previousProfile = { ...profile, baseFiles: [...profile.baseFiles, "custom.json"] };
    const nextProfile = profile;
    const previous: ManagedConfigItem[] = [{ path: "custom.json", kind: "put", hash: "a", size: 1, stagedRef: "a" }];
    expect(configProfileTransition({ previousProfile, nextProfile, previousItems: previous })).toEqual({ stopManaging: ["custom.json"], stillManaged: [] });
    expect(buildManagedConfigSnapshot({ profile: nextProfile, scan: { status: "captured", scopeRevision: "s", items: [] }, previousItems: previous, confirmedAbsentPaths: new Set(["custom.json"]) }))
      .toMatchObject({ status: "built", items: [] });
  });

  it("keeps profile-covered local extras as a different Tree instead of deleting or adopting them", () => {
    const previous: ManagedConfigItem[] = [{ path: "app.json", kind: "put", hash: "app", size: 1, stagedRef: "old-app" }];
    const result = buildManagedConfigSnapshot({
      profile,
      scan: { status: "captured", scopeRevision: "s", items: [
        { path: "app.json", hash: "app", size: 1, stagedRef: "new-app" },
        { path: "appearance.json", hash: "local-extra", size: 2, stagedRef: "extra" },
      ] },
      previousItems: previous,
      confirmedAbsentPaths: new Set(),
    });
    expect(result).toMatchObject({ status: "built", items: [
      { path: "app.json", kind: "put" },
      { path: "appearance.json", kind: "put", hash: "local-extra" },
    ] });
  });

  it("includes arbitrary package resources, excludes root data.json case aliases, and rejects put shape conflicts", () => {
    const plugins = { ...profile, portablePluginIds: ["p"], pluginPackages: ["p"] };
    const portablePluginManifestBytes = new Map([["p", manifest("p")]]);
    const packageScan = { status: "captured" as const, scopeRevision: "s", items: [
      { path: "plugins/p/manifest.json", hash: "a", size: 1, stagedRef: "a" },
      { path: "plugins/p/assets/icon.svg", hash: "b", size: 1, stagedRef: "b" },
      { path: "plugins/p/DATA.JSON", hash: "c", size: 1, stagedRef: "c" },
    ] };
    expect(buildManagedConfigSnapshot({ profile: plugins, scan: packageScan, previousItems: [], confirmedAbsentPaths: new Set(), portablePluginManifestBytes }))
      .toMatchObject({ status: "retry", reason: "invalid-profile", paths: ["plugins/p/DATA.JSON"] });

    const themeProfile = { ...profile, syncThemes: true };
    for (const items of [
      [{ path: "themes/Foo", hash: "a", size: 1, stagedRef: "a" }, { path: "themes/foo", hash: "b", size: 1, stagedRef: "b" }],
      [{ path: "themes/foo", hash: "a", size: 1, stagedRef: "a" }, { path: "themes/foo/bar.css", hash: "b", size: 1, stagedRef: "b" }],
    ]) {
      expect(buildManagedConfigSnapshot({ profile: themeProfile, scan: { status: "captured", scopeRevision: "s", items }, previousItems: [], confirmedAbsentPaths: new Set() }))
        .toMatchObject({ status: "retry", reason: "invalid-shape" });
    }
  });

  it("produces the same logical Tree hash for repeated rewrites of identical bytes", () => {
    const left = buildManagedConfigSnapshot({ profile, scan: { status: "captured", scopeRevision: "s", items: [{ path: "app.json", hash: "same", size: 1, stagedRef: "first" }] }, previousItems: [], confirmedAbsentPaths: new Set() });
    const right = buildManagedConfigSnapshot({ profile, scan: { status: "captured", scopeRevision: "s", items: [{ path: "app.json", hash: "same", size: 1, stagedRef: "second" }] }, previousItems: [], confirmedAbsentPaths: new Set() });
    expect(left.status === "built" && right.status === "built" && left.logicalHash).toBe(right.status === "built" ? right.logicalHash : "");
  });

  it("hashes the complete portable profile and enabled subset while ignoring device-local enablement", () => {
    const portableProfile = { ...profile, portablePluginIds: ["p"] };
    const manifests = new Map([["p", manifest("p")]]);
    const blobHash = "d".repeat(64);
    const scan = { status: "captured" as const, scopeRevision: "s", items: [{ path: "app.json", hash: blobHash, size: 1, stagedRef: "app" }] };
    const enabledFromDeviceA = portableEnabledPluginIds(["p", "device-a"], portableProfile, "obsidian-s3-sync");
    const enabledFromDeviceB = portableEnabledPluginIds(["p", "device-b"], portableProfile, "obsidian-s3-sync");
    const left = buildManagedConfigSnapshot({ profile: portableProfile, scan, previousItems: [], confirmedAbsentPaths: new Set(), enabledCommunityPlugins: enabledFromDeviceA, portablePluginManifestBytes: manifests });
    const right = buildManagedConfigSnapshot({ profile: portableProfile, scan, previousItems: [], confirmedAbsentPaths: new Set(), enabledCommunityPlugins: enabledFromDeviceB, portablePluginManifestBytes: manifests });
    expect(left.status).toBe("built");
    expect(right.status).toBe("built");
    if (left.status !== "built" || right.status !== "built") throw new Error("expected portable snapshots");
    expect(left.logicalHash).toBe(right.logicalHash);

    const disabled = buildManagedConfigSnapshot({ profile: portableProfile, scan, previousItems: [], confirmedAbsentPaths: new Set(), enabledCommunityPlugins: [], portablePluginManifestBytes: manifests });
    expect(disabled.status === "built" ? disabled.logicalHash : "").not.toBe(left.logicalHash);
    if (disabled.status !== "built") throw new Error("expected disabled portable snapshot");
    const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
    const descriptorHash = "a".repeat(64);
    const tree = materializeProtocolConfigTree(left, repositoryId, descriptorHash);
    const disabledTree = materializeProtocolConfigTree(disabled, repositoryId, descriptorHash);
    expect(tree).toMatchObject({ protocol: 1, profile: { schema: 1 }, enabledCommunityPlugins: ["p"], items: [{ path: "app.json", blobHash }] });
    const binding = { configDir: "settings", historicalConfigDirs: [] };
    const sizes = new Map([[blobHash, 1]]);
    expect(buildConfigTreeObject("", tree, binding, sizes).hash).not.toBe(buildConfigTreeObject("", disabledTree, binding, sizes).hash);
  });

  it("rejects duplicate scan paths and non-portable plugin manifests without throwing", () => {
    const duplicate = { status: "captured" as const, scopeRevision: "s", items: [
      { path: "app.json", hash: "a", size: 1, stagedRef: "a" },
      { path: "app.json", hash: "b", size: 1, stagedRef: "b" },
    ] };
    expect(buildManagedConfigSnapshot({ profile, scan: duplicate, previousItems: [], confirmedAbsentPaths: new Set() }))
      .toEqual({ status: "retry", reason: "invalid-shape" });

    const portableProfile = { ...profile, portablePluginIds: ["desktop-only"] };
    expect(buildManagedConfigSnapshot({
      profile: portableProfile,
      scan: { status: "captured", scopeRevision: "s", items: [] },
      previousItems: [],
      confirmedAbsentPaths: new Set(),
      portablePluginManifestBytes: new Map([["desktop-only", manifest("desktop-only", true)]]),
    })).toEqual({ status: "retry", reason: "invalid-profile" });
  });
});

function manifest(id: string, isDesktopOnly = false): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ id, version: "1.0.0", minAppVersion: "1.0.0", isDesktopOnly }));
}
