import { normalizeVaultPath, vaultPathCaseFoldKey } from "./path";
import { isConfigItemCovered } from "./config-profile";
import { isConfigPathExcluded } from "./scope";
import type { ConfigProfile } from "./types";

export type ConfigScopeClassification = "portable-item" | "community-enable-list" | "device-local" | "excluded" | "outside-config";

export function configRelativePath(actualConfigDir: string, vaultPath: string): string {
  const root = normalizeVaultPath(actualConfigDir);
  const path = normalizeVaultPath(vaultPath);
  if (!path.startsWith(`${root}/`)) throw new Error("Vault path is outside the actual configDir");
  return path.slice(root.length + 1);
}

export function classifyConfigVaultPath(input: {
  actualConfigDir: string;
  historicalConfigDirs: readonly string[];
  vaultPath: string;
  profile: ConfigProfile;
}): ConfigScopeClassification {
  let relative: string;
  try { relative = configRelativePath(input.actualConfigDir, input.vaultPath); }
  catch { return "outside-config"; }
  if (isConfigPathExcluded(relative, input.actualConfigDir, input.historicalConfigDirs)) return "excluded";
  const folded = vaultPathCaseFoldKey(relative);
  if (folded === "core-plugins.json" || /^workspace.*\.json$/.test(folded)) return "device-local";
  if (folded === "community-plugins.json") return "community-enable-list";
  return isConfigItemCovered(relative, input.profile) ? "portable-item" : "device-local";
}

export function portableConfigPaths(input: {
  actualConfigDir: string;
  historicalConfigDirs: readonly string[];
  vaultPaths: readonly string[];
  profile: ConfigProfile;
}): string[] {
  return input.vaultPaths
    .filter((vaultPath) => classifyConfigVaultPath({ ...input, vaultPath }) === "portable-item")
    .map((vaultPath) => configRelativePath(input.actualConfigDir, vaultPath))
    .sort();
}
