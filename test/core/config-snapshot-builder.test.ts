import { describe, expect, it } from "vitest";
import { createDefaultConfigProfile } from "../../core/config-profile";
import { buildManagedConfigSnapshot, configProfileTransition, type ManagedConfigItem } from "../../core/config-snapshot-builder";

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

  it("includes arbitrary package resources, excludes root data.json case aliases, and rejects put shape conflicts", () => {
    const plugins = { ...profile, portablePluginIds: ["p"], pluginPackages: ["p"] };
    const packageScan = { status: "captured" as const, scopeRevision: "s", items: [
      { path: "plugins/p/manifest.json", hash: "a", size: 1, stagedRef: "a" },
      { path: "plugins/p/assets/icon.svg", hash: "b", size: 1, stagedRef: "b" },
      { path: "plugins/p/DATA.JSON", hash: "c", size: 1, stagedRef: "c" },
    ] };
    expect(buildManagedConfigSnapshot({ profile: plugins, scan: packageScan, previousItems: [], confirmedAbsentPaths: new Set() }))
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
});
