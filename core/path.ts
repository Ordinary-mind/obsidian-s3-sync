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

export function validatePortablePath(path: string): string[] {
  const normalized = normalizeVaultPath(path);
  const violations: string[] = [];
  for (const segment of normalized.split("/")) {
    const stem = segment.split(".", 1)[0].toUpperCase();
    if (["CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$"].includes(stem) || /^(COM|LPT)([1-9]|[¹²³])$/.test(stem)) violations.push("windows-reserved-name");
    if (/[. ]$/.test(segment)) violations.push("windows-trailing-dot-or-space");
  }
  return [...new Set(violations)];
}
