import type { ConfigProfile } from "./types";
import { validatePortablePluginId, vaultPathCaseFoldKey } from "./path";

export function isConfigItemCovered(path: string, profile: ConfigProfile): boolean {
  if (profile.baseFiles.includes(path) && !path.includes("/")) return true;
  if (profile.syncThemes && path.startsWith("themes/") && path.length > 7) return true;
  if (profile.syncSnippets && path.startsWith("snippets/") && path.length > 9) return true;
  const match = /^plugins\/([^/]+)\/(.+)$/.exec(path);
  if (!match) return false;
  const [, pluginId, relativePath] = match;
  return (profile.pluginPackages.includes(pluginId) && relativePath !== "data.json") || (profile.pluginData.includes(pluginId) && relativePath === "data.json");
}

export function hasPackageManifestAnchor(items: ReadonlyArray<{ path: string; kind: "put" | "delete" }>, profile: ConfigProfile): boolean {
  const puts = new Set(items.filter((item) => item.kind === "put").map((item) => item.path));
  return profile.pluginPackages.every((pluginId) => ![...puts].some((path) => path.startsWith(`plugins/${pluginId}/`)) || puts.has(`plugins/${pluginId}/manifest.json`));
}

export function isPortablePluginIdAllowed(pluginId: string, syncPluginId: string): boolean {
  return validatePortablePluginId(pluginId).length === 0
    && vaultPathCaseFoldKey(pluginId) !== vaultPathCaseFoldKey(syncPluginId);
}
