import { defaultCaseFold151, normalizeNfc151 } from "../protocol/unicode";

const WINDOWS_RESERVED_STEM = /^(CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM([1-9]|[¹²³])|LPT([1-9]|[¹²³]))$/;
const WINDOWS_ILLEGAL_CHARACTER = /[<>:"\\|?*\u0000-\u001f]/;

export function normalizeVaultPath(path: string): string {
  const normalized = normalizeNfc151(path);
  if (normalized.length === 0 || normalized.startsWith("/") || normalized.includes("\\") || normalized.endsWith("/")) throw new Error("invalid Vault relative path");
  if (normalized.split("/").some((part) => part.length === 0 || part === "." || part === "..")) throw new Error("invalid Vault path segment");
  return normalized;
}

export function validateRemoteVaultPath(path: string): string {
  const normalized = normalizeVaultPath(path);
  if (normalized !== path) throw new Error("remote Vault path must be NFC");
  return path;
}

export function findNfcPathCollisions(paths: readonly string[]): string[][] {
  const groups = new Map<string, Set<string>>();
  for (const path of paths) {
    const normalized = normalizeVaultPath(path);
    const rawPaths = groups.get(normalized) ?? new Set<string>();
    rawPaths.add(path);
    groups.set(normalized, rawPaths);
  }
  return [...groups.values()]
    .filter((rawPaths) => rawPaths.size > 1)
    .map((rawPaths) => [...rawPaths].sort())
    .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
}

export function vaultPathCaseFoldKey(path: string): string {
  return defaultCaseFold151(normalizeVaultPath(path));
}

export function validatePortablePath(path: string): string[] {
  const normalized = normalizeVaultPath(path);
  return [...new Set(normalized.split("/").flatMap(validatePortableSegment))];
}

export function validatePortablePluginId(pluginId: string): string[] {
  const violations: string[] = [];
  if (pluginId.length === 0 || new TextEncoder().encode(pluginId).byteLength > 255) violations.push("plugin-id-length");
  if (normalizeNfc151(pluginId) !== pluginId) violations.push("non-nfc");
  if (pluginId.includes("/")) violations.push("windows-illegal-character");
  violations.push(...validatePortableSegment(pluginId));
  return [...new Set(violations)];
}

function validatePortableSegment(segment: string): string[] {
  const violations: string[] = [];
  const stem = segment.split(".", 1)[0].toUpperCase();
  if (WINDOWS_RESERVED_STEM.test(stem)) violations.push("windows-reserved-name");
  if (WINDOWS_ILLEGAL_CHARACTER.test(segment)) violations.push("windows-illegal-character");
  if (/[. ]$/.test(segment)) violations.push("windows-trailing-dot-or-space");
  return violations;
}
