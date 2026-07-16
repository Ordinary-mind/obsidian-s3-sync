import type { ConfigProfile } from "./types";
import { normalizeVaultPath, validatePortablePluginId, vaultPathCaseFoldKey } from "./path";
import { compareUtf8 } from "../protocol/utf8";

export const DEFAULT_CONFIG_BASE_FILES = ["app.json", "appearance.json", "hotkeys.json"] as const;

export function createDefaultConfigProfile(minimumTargetAppVersion: string): ConfigProfile {
  return {
    baseFiles: [...DEFAULT_CONFIG_BASE_FILES],
    syncThemes: false,
    syncSnippets: false,
    portablePluginIds: [],
    pluginPackages: [],
    pluginData: [],
    minimumTargetAppVersion,
  };
}

export function validateConfigProfile(profile: ConfigProfile, syncPluginId = "obsidian-s3-sync"): string[] {
  const violations: string[] = [];
  const forbiddenBaseNames = ["community-plugins.json", "core-plugins.json", "plugins", "themes", "snippets", ".obsidian-s3-sync-local"];
  const baseAliases = new Set<string>();
  if (profile.baseFiles.length > 100_000 || !isUtf8SortedUnique(profile.baseFiles)) violations.push("base-files-not-canonical");
  for (const baseFile of profile.baseFiles) {
    if (baseFile.includes("/") || baseFile.length === 0) violations.push("base-file-not-root-file");
    let folded: string;
    try {
      if (normalizeVaultPath(baseFile) !== baseFile) throw new Error("base file is not NFC");
      folded = vaultPathCaseFoldKey(baseFile);
    } catch { violations.push("invalid-base-file"); continue; }
    if (baseAliases.has(folded)) violations.push("base-file-alias");
    baseAliases.add(folded);
    if (forbiddenBaseNames.some((name) => vaultPathCaseFoldKey(name) === folded)
      || folded.startsWith("workspace") && folded.endsWith(".json")) violations.push("forbidden-base-file");
  }
  const portable = validatePluginIdArray(profile.portablePluginIds, syncPluginId, "portable", violations);
  for (const [name, values] of [["package", profile.pluginPackages], ["data", profile.pluginData]] as const) {
    const ids = validatePluginIdArray(values, syncPluginId, name, violations);
    if ([...ids].some((id) => !portable.has(id))) violations.push(`${name}-not-portable`);
  }
  if (!profile.minimumTargetAppVersion || !isPlainThreePartVersion(profile.minimumTargetAppVersion)) violations.push("invalid-minimum-target-version");
  return [...new Set(violations)];
}

export function isConfigItemCovered(path: string, profile: ConfigProfile): boolean {
  if (profile.baseFiles.includes(path) && !path.includes("/")) return true;
  if (profile.syncThemes && path.startsWith("themes/") && path.length > 7) return true;
  if (profile.syncSnippets && path.startsWith("snippets/") && path.length > 9) return true;
  const match = /^plugins\/([^/]+)\/(.+)$/.exec(path);
  if (!match) return false;
  const [, pluginId, relativePath] = match;
  return (profile.pluginPackages.includes(pluginId) && vaultPathCaseFoldKey(relativePath) !== "data.json") || (profile.pluginData.includes(pluginId) && relativePath === "data.json");
}

export function configItemCoverageSources(path: string, profile: ConfigProfile): string[] {
  const sources: string[] = [];
  if (profile.baseFiles.includes(path) && !path.includes("/")) sources.push(`base:${path}`);
  if (profile.syncThemes && path.startsWith("themes/") && path.length > 7) sources.push("themes");
  if (profile.syncSnippets && path.startsWith("snippets/") && path.length > 9) sources.push("snippets");
  const match = /^plugins\/([^/]+)\/(.+)$/.exec(path);
  if (match) {
    const [, pluginId, relativePath] = match;
    if (profile.pluginPackages.includes(pluginId) && vaultPathCaseFoldKey(relativePath) !== "data.json") sources.push(`package:${pluginId}`);
    if (profile.pluginData.includes(pluginId) && relativePath === "data.json") sources.push(`data:${pluginId}`);
  }
  return sources;
}

export function hasPackageManifestAnchor(items: ReadonlyArray<{ path: string; kind: "put" | "delete" }>, profile: ConfigProfile): boolean {
  const puts = new Set(items.filter((item) => item.kind === "put").map((item) => item.path));
  return profile.pluginPackages.every((pluginId) => ![...puts].some((path) => path.startsWith(`plugins/${pluginId}/`)) || puts.has(`plugins/${pluginId}/manifest.json`));
}

export function isPortablePluginIdAllowed(pluginId: string, syncPluginId: string): boolean {
  return validatePortablePluginId(pluginId).length === 0
    && vaultPathCaseFoldKey(pluginId) !== vaultPathCaseFoldKey(syncPluginId);
}

function validatePluginIdArray(values: readonly string[], syncPluginId: string, name: string, violations: string[]): Set<string> {
  const aliases = new Set<string>();
  const exact = new Set<string>();
  if (values.length > 100_000 || !isUtf8SortedUnique(values)) violations.push(`${name}-plugins-not-canonical`);
  for (const id of values) {
    if (!isPortablePluginIdAllowed(id, syncPluginId)) {
      violations.push(`${name}-plugin-id-invalid`);
      continue;
    }
    const folded = vaultPathCaseFoldKey(id);
    if (aliases.has(folded)) violations.push(`${name}-plugin-id-alias`);
    aliases.add(folded);
    if (exact.has(id)) violations.push(`${name}-plugin-id-duplicate`);
    exact.add(id);
  }
  return exact;
}

function isPlainThreePartVersion(value: string): boolean {
  return /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value);
}

function isUtf8SortedUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (compareUtf8(values[index - 1], values[index]) >= 0) return false;
  }
  return true;
}
