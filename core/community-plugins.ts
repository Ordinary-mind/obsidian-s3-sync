import { canonicalizeProtocolJson, parseBoundedJson } from "../protocol/json";
import { validatePortablePluginId, vaultPathCaseFoldKey } from "./path";
import type { ConfigProfile } from "./types";

const communityPluginsMaximumBytes = 4 * 1024 * 1024;
const communityPluginsMaximumIds = 100_000;

export function parseCommunityPluginIds(bytes: Uint8Array): string[] {
  const value = parseBoundedJson(bytes, communityPluginsMaximumBytes, "array");
  if (!Array.isArray(value) || value.length > communityPluginsMaximumIds || value.some((id) => typeof id !== "string")) {
    throw new Error("community-plugins.json must be an array of plugin IDs");
  }
  const aliases = new Set<string>();
  const result: string[] = [];
  for (const id of value as string[]) {
    if (validatePortablePluginId(id).length > 0) throw new Error("community-plugins.json contains an invalid plugin ID");
    const alias = vaultPathCaseFoldKey(id);
    if (aliases.has(alias)) throw new Error("community-plugins.json contains a duplicate or case-fold alias");
    aliases.add(alias);
    result.push(id);
  }
  return result;
}

export function portableEnabledPluginIds(localEnabled: readonly string[], profile: ConfigProfile, syncPluginId: string): string[] {
  const local = new Set(localEnabled);
  const syncAlias = vaultPathCaseFoldKey(syncPluginId);
  return profile.portablePluginIds
    .filter((id) => local.has(id) && vaultPathCaseFoldKey(id) !== syncAlias)
    .sort(compareUtf8);
}

export function mergePortableEnabledPluginIds(input: {
  remotePortableEnabled: readonly string[];
  localEnabled: readonly string[];
  portablePluginIds: readonly string[];
  localPluginDirectories?: readonly string[];
  syncPluginId: string;
}): string[] {
  const portableAliases = new Map(input.portablePluginIds.map((id) => [vaultPathCaseFoldKey(id), id]));
  const remote = new Set(input.remotePortableEnabled);
  if ([...remote].some((id) => !input.portablePluginIds.includes(id))) throw new Error("remote enabled plugin is not portable");
  for (const id of [...input.localEnabled, ...(input.localPluginDirectories ?? [])]) {
    const portable = portableAliases.get(vaultPathCaseFoldKey(id));
    if (portable && portable !== id) throw new Error("local plugin aliases a portable plugin ID");
  }
  const unmanaged = input.localEnabled.filter((id) => !portableAliases.has(vaultPathCaseFoldKey(id)));
  return [...new Set([...unmanaged, ...remote, input.syncPluginId])].sort(compareUtf8);
}

export function encodeCommunityPluginIds(ids: readonly string[]): Uint8Array {
  if (ids.length > communityPluginsMaximumIds) throw new Error("community plugin list exceeds 100,000 IDs");
  const canonical = canonicalizeProtocolJson([...ids].sort(compareUtf8));
  const bytes = new TextEncoder().encode(canonical);
  if (bytes.byteLength > communityPluginsMaximumBytes) throw new Error("community plugin list exceeds 4 MiB");
  parseCommunityPluginIds(bytes);
  return bytes;
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const a = encoder.encode(left); const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return a.length - b.length;
}
