import { vaultPathCaseFoldKey } from "./path";

export function isVaultPathExcluded(path: string, configDir: string, historicalConfigDirs: readonly string[]): boolean {
  const key = vaultPathCaseFoldKey(path);
  const roots = [configDir, ...historicalConfigDirs, ".s3-sync-conflicts", ".obsidian-s3-sync-local"];
  return roots.some((root) => {
    const rootKey = vaultPathCaseFoldKey(root);
    return key === rootKey || key.startsWith(`${rootKey}/`);
  });
}
