import { canonicalizeProtocolJson } from "../protocol/json";
import { sha256Hex } from "../protocol/hash";
import { configItemCoverageSources, hasPackageManifestAnchor, validateConfigProfile } from "./config-profile";
import { validatePortablePluginManifests } from "./config-compatibility";
import type { ConfigScanItem, StableConfigScanResult } from "./config-scan";
import { validatePortablePluginId, vaultPathCaseFoldKey } from "./path";
import type { ConfigProfile } from "./types";
import type { ProtocolConfigTree } from "./config-tree";

export type ManagedConfigItem =
  | { path: string; kind: "put"; hash: string; size: number; stagedRef: string }
  | { path: string; kind: "delete" };

export type ConfigSnapshotBuildResult =
  | { status: "built"; profile: ConfigProfile; enabledCommunityPlugins: string[]; items: ManagedConfigItem[]; logicalHash: string }
  | { status: "retry"; reason: "scan-incomplete" | "missing-not-confirmed" | "invalid-profile" | "invalid-shape"; paths?: string[] };

export function buildManagedConfigSnapshot(input: {
  profile: ConfigProfile;
  scan: StableConfigScanResult;
  previousItems: readonly ManagedConfigItem[];
  confirmedAbsentPaths: ReadonlySet<string>;
  enabledCommunityPlugins?: readonly string[];
  portablePluginManifestBytes?: ReadonlyMap<string, Uint8Array>;
  syncPluginId?: string;
}): ConfigSnapshotBuildResult {
  if (input.scan.status !== "captured") return { status: "retry", reason: "scan-incomplete" };
  if (validateConfigProfile(input.profile, input.syncPluginId).length > 0) return { status: "retry", reason: "invalid-profile" };
  if (input.profile.portablePluginIds.length > 0
    && validatePortablePluginManifests(input.profile, input.portablePluginManifestBytes ?? new Map()).length > 0) {
    return { status: "retry", reason: "invalid-profile" };
  }
  const enabledCommunityPlugins = [...(input.enabledCommunityPlugins ?? [])];
  if (!validateEnabledCommunityPlugins(enabledCommunityPlugins, input.profile, input.syncPluginId ?? "obsidian-s3-sync")) {
    return { status: "retry", reason: "invalid-profile" };
  }
  let current: Map<string, ConfigScanItem>;
  let previous: Map<string, ManagedConfigItem>;
  try {
    current = uniqueScanItems(input.scan.items);
    previous = uniqueManagedItems(input.previousItems);
  } catch {
    return { status: "retry", reason: "invalid-shape" };
  }
  const next = new Map<string, ManagedConfigItem>();

  for (const item of current.values()) {
    if (configItemCoverageSources(item.path, input.profile).length !== 1) return { status: "retry", reason: "invalid-profile", paths: [item.path] };
    next.set(item.path, { path: item.path, kind: "put", hash: item.hash, size: item.size, stagedRef: item.stagedRef });
  }

  const unconfirmed: string[] = [];
  for (const item of previous.values()) {
    const covered = configItemCoverageSources(item.path, input.profile).length === 1;
    if (!covered || next.has(item.path)) continue;
    if (item.kind === "delete") {
      next.set(item.path, { path: item.path, kind: "delete" });
    } else if (input.confirmedAbsentPaths.has(item.path)) {
      next.set(item.path, { path: item.path, kind: "delete" });
    } else {
      unconfirmed.push(item.path);
    }
  }
  if (unconfirmed.length > 0) return { status: "retry", reason: "missing-not-confirmed", paths: unconfirmed.sort(compareUtf8) };
  const items = [...next.values()].sort((left, right) => compareUtf8(left.path, right.path));
  try {
    if (hasIllegalPutShape(items)) return { status: "retry", reason: "invalid-shape" };
  } catch {
    return { status: "retry", reason: "invalid-shape" };
  }
  if (!hasPackageManifestAnchor(items, input.profile)) return { status: "retry", reason: "invalid-profile" };
  const hashInput = items.map((item) => item.kind === "put"
    ? { path: item.path, kind: item.kind, hash: item.hash, size: item.size }
    : { path: item.path, kind: item.kind });
  const profile = structuredClone(input.profile);
  const logicalHash = sha256Hex(new TextEncoder().encode(canonicalizeProtocolJson({
    profile: { schema: 1, ...profile },
    enabledCommunityPlugins,
    items: hashInput,
  })));
  return { status: "built", profile, enabledCommunityPlugins, items, logicalHash };
}

export function materializeProtocolConfigTree(
  snapshot: Extract<ConfigSnapshotBuildResult, { status: "built" }>,
  repositoryId: string,
  descriptorHash: string,
): ProtocolConfigTree {
  if (!snapshot.profile.minimumTargetAppVersion) throw new Error("ConfigProfile minimumTargetAppVersion is required");
  return {
    protocol: 1,
    repositoryId,
    descriptorHash,
    profile: { schema: 1, ...structuredClone(snapshot.profile), minimumTargetAppVersion: snapshot.profile.minimumTargetAppVersion },
    enabledCommunityPlugins: [...snapshot.enabledCommunityPlugins],
    items: snapshot.items.map((item) => item.kind === "put"
      ? { path: item.path, kind: item.kind, blobHash: item.hash, size: item.size }
      : { path: item.path, kind: item.kind }),
  };
}

export function configProfileTransition(input: {
  previousProfile: ConfigProfile;
  nextProfile: ConfigProfile;
  previousItems: readonly ManagedConfigItem[];
}): { stopManaging: string[]; stillManaged: string[] } {
  const stopManaging: string[] = [];
  const stillManaged: string[] = [];
  for (const item of input.previousItems) {
    const wasCovered = configItemCoverageSources(item.path, input.previousProfile).length === 1;
    const nowCovered = configItemCoverageSources(item.path, input.nextProfile).length === 1;
    if (wasCovered && !nowCovered) stopManaging.push(item.path);
    else if (nowCovered) stillManaged.push(item.path);
  }
  return { stopManaging: stopManaging.sort(compareUtf8), stillManaged: stillManaged.sort(compareUtf8) };
}

function uniqueScanItems(items: readonly ConfigScanItem[]): Map<string, ConfigScanItem> {
  const result = new Map<string, ConfigScanItem>();
  for (const item of items) {
    if (result.has(item.path)) throw new Error("config scan contains duplicate path");
    result.set(item.path, item);
  }
  return result;
}

function uniqueManagedItems(items: readonly ManagedConfigItem[]): Map<string, ManagedConfigItem> {
  const result = new Map<string, ManagedConfigItem>();
  for (const item of items) {
    if (result.has(item.path)) throw new Error("previous ConfigTree contains duplicate path");
    result.set(item.path, item);
  }
  return result;
}

function hasIllegalPutShape(items: readonly ManagedConfigItem[]): boolean {
  const puts = items.filter((item) => item.kind === "put");
  const aliases = new Set<string>();
  for (const item of puts) {
    const alias = vaultPathCaseFoldKey(item.path);
    if (aliases.has(alias)) return true;
    aliases.add(alias);
  }
  const paths = puts.map((item) => item.path).sort(compareUtf8);
  return paths.some((path, index) => paths.slice(index + 1).some((other) => other.startsWith(`${path}/`)));
}

function validateEnabledCommunityPlugins(values: readonly string[], profile: ConfigProfile, syncPluginId: string): boolean {
  if (values.length > 100_000) return false;
  const portable = new Set(profile.portablePluginIds);
  const aliases = new Set<string>();
  const syncAlias = vaultPathCaseFoldKey(syncPluginId);
  for (let index = 0; index < values.length; index += 1) {
    const id = values[index];
    if (!portable.has(id) || validatePortablePluginId(id).length > 0) return false;
    const alias = vaultPathCaseFoldKey(id);
    if (alias === syncAlias || aliases.has(alias)) return false;
    aliases.add(alias);
    if (index > 0 && compareUtf8(values[index - 1], id) >= 0) return false;
  }
  return true;
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder(); const a = encoder.encode(left); const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return a.length - b.length;
}
