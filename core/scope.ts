import { vaultPathCaseFoldKey } from "./path";

export const VAULT_CONFLICT_ROOT = ".s3-sync-conflicts";
export const LOCAL_STATE_CONTAINER = ".obsidian-s3-sync-local";
export const SYNC_PLUGIN_CONFIG_ROOT = "plugins/obsidian-s3-sync";

export function isVaultPathExcluded(path: string, configDir: string, historicalConfigDirs: readonly string[]): boolean {
  const key = vaultPathCaseFoldKey(path);
  const roots = [configDir, ...historicalConfigDirs, VAULT_CONFLICT_ROOT];
  return roots.some((root) => {
    const rootKey = vaultPathCaseFoldKey(root);
    return key === rootKey || key.startsWith(`${rootKey}/`);
  });
}

export function isConfigPathExcluded(
  path: string,
  configDir?: string,
  historicalConfigDirs: readonly string[] = [],
): boolean {
  const key = vaultPathCaseFoldKey(path);
  const roots = [LOCAL_STATE_CONTAINER, SYNC_PLUGIN_CONFIG_ROOT];
  if (configDir) {
    const currentKey = vaultPathCaseFoldKey(configDir);
    for (const historicalDir of historicalConfigDirs) {
      const historicalKey = vaultPathCaseFoldKey(historicalDir);
      if (historicalKey.startsWith(`${currentKey}/`)) roots.push(historicalKey.slice(currentKey.length + 1));
    }
  }
  return roots.some((root) => key === root || key.startsWith(`${root}/`));
}

export function localStateRoot(configDir: string, repositoryId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(repositoryId)) {
    throw new Error("invalid repositoryId for local state root");
  }
  return `${configDir}/${LOCAL_STATE_CONTAINER}/${repositoryId}`;
}

export function sensitivePathExclusions(
  configDir: string,
  historicalConfigDirs: readonly string[],
  repositoryId: string,
): { vault: string[]; config: string[] } {
  localStateRoot(configDir, repositoryId);
  return {
    vault: [...new Set([configDir, ...historicalConfigDirs, VAULT_CONFLICT_ROOT])],
    config: [`${LOCAL_STATE_CONTAINER}/${repositoryId}`, SYNC_PLUGIN_CONFIG_ROOT],
  };
}

export function isConfigPathExcludedForRepository(path: string, repositoryId: string): boolean {
  const key = vaultPathCaseFoldKey(path);
  return [`${LOCAL_STATE_CONTAINER}/${repositoryId}`, SYNC_PLUGIN_CONFIG_ROOT].some((root) => {
    const rootKey = vaultPathCaseFoldKey(root);
    return key === rootKey || key.startsWith(`${rootKey}/`);
  });
}

export function isHistoricalConfigCompatible(localHistoricalConfigDirs: readonly string[], descriptorHistoricalConfigDirs: readonly string[]): boolean {
  const descriptor = new Set(descriptorHistoricalConfigDirs.map(vaultPathCaseFoldKey));
  return localHistoricalConfigDirs.every((path) => descriptor.has(vaultPathCaseFoldKey(path)));
}

export type ConfigDirBindingPlan =
  | { status: "match" }
  | { status: "requires-new-generation"; configDir: string; historicalConfigDirs: string[] };

export function planConfigDirBinding(input: {
  descriptorConfigDir: string;
  descriptorHistoricalConfigDirs: readonly string[];
  actualConfigDir: string;
  localHistoricalConfigDirs: readonly string[];
}): ConfigDirBindingPlan {
  const currentMatches = vaultPathCaseFoldKey(input.descriptorConfigDir) === vaultPathCaseFoldKey(input.actualConfigDir);
  const historiesMatch = isHistoricalConfigCompatible(input.localHistoricalConfigDirs, input.descriptorHistoricalConfigDirs);
  if (currentMatches && historiesMatch) return { status: "match" };
  const historicalConfigDirs: string[] = [];
  const seen = new Set<string>();
  for (const path of [input.descriptorConfigDir, ...input.descriptorHistoricalConfigDirs, ...input.localHistoricalConfigDirs]) {
    const key = vaultPathCaseFoldKey(path);
    if (key === vaultPathCaseFoldKey(input.actualConfigDir) || seen.has(key)) continue;
    seen.add(key);
    historicalConfigDirs.push(path);
  }
  return { status: "requires-new-generation", configDir: input.actualConfigDir, historicalConfigDirs };
}
