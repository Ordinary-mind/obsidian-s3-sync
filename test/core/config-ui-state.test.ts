import { describe, expect, it } from "vitest";
import { createDefaultConfigProfile } from "../../core/config-profile";
import {
  buildMultiSourceConfigMerge,
  configTrustRequirements,
  deriveConfigRegisterUiState,
  summarizeConfigPluginChanges,
  summarizeConfigProfileTransition,
} from "../../core/config-ui-state";
import type { ManagedConfigItem } from "../../core/config-snapshot-builder";

describe("config UI state", () => {
  const profile = createDefaultConfigProfile("1.8.0");

  it("keeps pending, conflict, incompatibility, and apply failure out of generic network state", () => {
    expect(deriveConfigRegisterUiState({ enabled: true, repositoryBound: true, remoteDisposition: "pending", pendingVersions: ["p"] }))
      .toMatchObject({ status: "pending", pendingVersions: ["p"] });
    expect(deriveConfigRegisterUiState({ enabled: true, repositoryBound: true, remoteDisposition: "conflict", remoteHeads: ["b", "a"] }))
      .toMatchObject({ status: "conflict", remoteHeads: ["a", "b"] });
    expect(deriveConfigRegisterUiState({ enabled: true, repositoryBound: true, remoteDisposition: "resolved", compatible: false }))
      .toMatchObject({ status: "incompatible" });
    expect(deriveConfigRegisterUiState({ enabled: true, repositoryBound: true, remoteDisposition: "resolved", applyFailure: "rolled-back" }))
      .toMatchObject({ status: "apply-failed" });
    expect(deriveConfigRegisterUiState({ enabled: true, repositoryBound: true, remoteDisposition: "resolved", applyFailure: "recovery-required" }))
      .toMatchObject({ status: "recovery-required" });
  });

  it("separates scope removal from explicit propagated deletion", () => {
    const previousProfile = { ...profile, baseFiles: [...profile.baseFiles, "custom.json", "removed.json"].sort() };
    const nextProfile = { ...profile, baseFiles: [...profile.baseFiles, "custom.json"].sort() };
    const items: ManagedConfigItem[] = [put("custom.json", "a"), put("removed.json", "b")];
    expect(summarizeConfigProfileTransition({
      previousProfile,
      nextProfile,
      previousItems: items,
      explicitDeletePaths: ["custom.json", "removed.json"],
    })).toMatchObject({
      stopManaging: ["removed.json"],
      propagateDeletes: ["custom.json"],
      stillManaged: ["custom.json"],
      violations: [],
    });
  });

  it("builds a multi-source merge only from explicit per-path choices", () => {
    const pluginProfile = {
      ...profile,
      portablePluginIds: ["p"],
      pluginPackages: ["p"],
    };
    const sources = [
      { id: "local", profile: pluginProfile, enabledCommunityPlugins: [], items: [put("app.json", "a"), put("plugins/p/manifest.json", "m")] },
      { id: "remote-a", profile: pluginProfile, enabledCommunityPlugins: ["p"], items: [put("app.json", "b"), put("plugins/p/manifest.json", "m")] },
      { id: "remote-b", profile: pluginProfile, enabledCommunityPlugins: [], items: [put("hotkeys.json", "c")] },
    ];
    expect(() => buildMultiSourceConfigMerge({
      sources,
      selections: {},
      profileSourceId: "remote-a",
      enabledSourceId: "remote-a",
    })).toThrow("explicit selection");
    expect(buildMultiSourceConfigMerge({
      sources,
      selections: {
        "app.json": "local",
        "hotkeys.json": "remote-b",
        "plugins/p/manifest.json": "remote-a",
      },
      profileSourceId: "remote-a",
      enabledSourceId: "remote-a",
    })).toMatchObject({
      enabledCommunityPlugins: ["p"],
      items: [
        { path: "app.json", hash: "a" },
        { path: "hotkeys.json", hash: "c" },
        { path: "plugins/p/manifest.json", hash: "m" },
      ],
    });
  });

  it("shows plugin version, writer source, compatibility, and independent trust requirements", () => {
    const diff = [
      { path: "plugins/p/main.js", kind: "modify" as const, codeChange: true, sensitive: false },
      { path: "plugins/p/data.json", kind: "modify" as const, codeChange: false, sensitive: true },
    ];
    expect(summarizeConfigPluginChanges({
      diff,
      manifests: { p: { id: "p", version: "2.0.0", minAppVersion: "1.0.0" } },
      sourceWriters: ["writer-b", "writer-a"],
    })).toEqual([{
      pluginId: "p",
      version: "2.0.0",
      sourceWriters: ["writer-a", "writer-b"],
      codePaths: ["plugins/p/main.js"],
      dataPaths: ["plugins/p/data.json"],
      compatibility: "compatible",
      compatibilityReasons: [],
    }]);
    expect(configTrustRequirements({ diff, loadedPluginIds: ["p"], newPluginIds: ["p"] })).toEqual({
      pluginCode: true,
      pluginData: true,
      loadedPlugins: true,
      newPlugins: true,
    });
  });
});

function put(path: string, hash: string): ManagedConfigItem {
  return { path, kind: "put", hash, size: 1, stagedRef: `${hash}:${path}` };
}
