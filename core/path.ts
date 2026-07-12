import { defaultCaseFold151, normalizeNfc151 } from "../protocol/unicode";

export function normalizeVaultPath(path: string): string {
  const normalized = normalizeNfc151(path);
  if (normalized.length === 0 || normalized.startsWith("/") || normalized.includes("\\") || normalized.endsWith("/")) throw new Error("invalid Vault relative path");
  if (normalized.split("/").some((part) => part.length === 0 || part === "." || part === "..")) throw new Error("invalid Vault path segment");
  return normalized;
}

export function vaultPathCaseFoldKey(path: string): string {
  return defaultCaseFold151(normalizeVaultPath(path));
}
