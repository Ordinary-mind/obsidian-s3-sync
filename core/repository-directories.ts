import { vaultPathCaseFoldKey, normalizeVaultPath } from "./path";
import { VAULT_CONFLICT_ROOT } from "./scope";
import { compareUtf8 } from "../protocol/utf8";

export function validateRepositoryDirectories(configDir: string, historicalConfigDirs: readonly string[]): {
  configDir: string;
  historicalConfigDirs: string[];
} {
  const current = normalizeVaultPath(configDir);
  const histories = historicalConfigDirs.map(normalizeVaultPath).sort(compareUtf8);
  const seen = new Set<string>();
  const currentFold = vaultPathCaseFoldKey(current);
  for (const history of histories) {
    const folded = vaultPathCaseFoldKey(history);
    if (folded === currentFold) throw new Error("historical configDir aliases the current configDir");
    if (seen.has(folded)) throw new Error("historical configDirs contain a case-fold alias");
    seen.add(folded);
  }
  for (const root of [current, ...histories]) {
    if (pathsRelated(root, VAULT_CONFLICT_ROOT)) throw new Error("configDir collides with the Vault conflict root");
  }
  return { configDir: current, historicalConfigDirs: histories };
}

function pathsRelated(left: string, right: string): boolean {
  const leftKey = vaultPathCaseFoldKey(left);
  const rightKey = vaultPathCaseFoldKey(right);
  return leftKey === rightKey || leftKey.startsWith(`${rightKey}/`) || rightKey.startsWith(`${leftKey}/`);
}
