import { canonicalizeProtocolJson } from "../protocol/json";
import { sha256Hex } from "../protocol/hash";
import { portableEnabledPluginIds, observeCommunityPluginIds } from "./community-plugins";
import { captureStableConfigScan, type ConfigScanObservation } from "./config-scan";
import { buildManagedConfigSnapshot, materializeProtocolConfigTree, type ManagedConfigItem } from "./config-snapshot-builder";
import { buildConfigTreeObject, type ConfigTreeBinding, type ProtocolConfigTree } from "./config-tree";
import { parsePluginManifest } from "./plugin-manifest";
import type { PluginManifestInfo } from "./plugin-compatibility";
import { isConfigItemCovered, validateConfigProfile } from "./config-profile";
import { vaultPathCaseFoldKey } from "./path";
import type { ConfigProfile } from "./types";
import { safeErrorMessage } from "./safe-error";
import { compareUtf8 } from "../protocol/utf8";

export interface ConfigInspectionPort {
  stat(path: string): Promise<{ type: "file" | "folder" | "symlink" | "other"; size?: number } | null>;
  list(path: string): Promise<string[]>;
  read(path: string): Promise<Uint8Array>;
}

export interface LocalPluginInventoryEntry {
  directoryId: string;
  manifest?: PluginManifestInfo;
  error?: string;
}

export interface ConfigWorkspaceScan {
  observation: ConfigScanObservation;
  bytesByPath: Map<string, Uint8Array>;
  manifestBytesByPluginId: Map<string, Uint8Array>;
  allEnabledPluginIds: string[];
  confirmedAbsentPaths: Set<string>;
}

export type LocalConfigSnapshotResult =
  | {
    status: "captured";
    tree: ProtocolConfigTree;
    treeHash: string;
    items: ManagedConfigItem[];
    bytesByPath: Map<string, Uint8Array>;
    manifestBytesByPluginId: Map<string, Uint8Array>;
    allEnabledPluginIds: string[];
    scopeRevision: string;
  }
  | { status: "retry"; reason: string; paths?: string[]; error?: unknown };

const maximumConfigItems = 100_000;

export async function inspectConfigWorkspaceOnce(input: {
  port: ConfigInspectionPort;
  profile: ConfigProfile;
  previousItems?: readonly ManagedConfigItem[];
  syncPluginId?: string;
}): Promise<ConfigWorkspaceScan> {
  const violations = validateConfigProfile(input.profile, input.syncPluginId);
  if (violations.length > 0) return unknown(`invalid ConfigProfile: ${violations.join(",")}`);
  const bytesByPath = new Map<string, Uint8Array>();
  const confirmedAbsentPaths = new Set<string>();
  try {
    for (const path of input.profile.baseFiles) await inspectFile(input.port, path, bytesByPath);
    if (input.profile.syncThemes) await inspectDirectory(input.port, "themes", bytesByPath);
    if (input.profile.syncSnippets) await inspectDirectory(input.port, "snippets", bytesByPath);
    for (const pluginId of input.profile.pluginPackages) {
      await inspectDirectory(input.port, `plugins/${pluginId}`, bytesByPath, (path) => {
        const relative = path.slice(`plugins/${pluginId}/`.length);
        return vaultPathCaseFoldKey(relative) !== "data.json" || input.profile.pluginData.includes(pluginId);
      });
    }
    for (const pluginId of input.profile.pluginData) {
      await inspectFile(input.port, `plugins/${pluginId}/data.json`, bytesByPath);
    }
    if (bytesByPath.size > maximumConfigItems) throw new Error("config scan exceeds 100,000 items");

    const manifestBytesByPluginId = new Map<string, Uint8Array>();
    for (const pluginId of input.profile.portablePluginIds) {
      const path = `plugins/${pluginId}/manifest.json`;
      const bytes = bytesByPath.get(path) ?? await readOptionalRegularFile(input.port, path);
      if (bytes) manifestBytesByPluginId.set(pluginId, bytes);
    }

    const communityBytes = await readOptionalRegularFile(input.port, "community-plugins.json");
    const enabledObservation = observeCommunityPluginIds(communityBytes
      ? { kind: "present", bytes: communityBytes }
      : { kind: "confirmed-absent" });
    if (enabledObservation.status !== "complete") return unknown(enabledObservation.reason);

    const items = [...bytesByPath.entries()].map(([path, bytes]) => ({
      path,
      hash: sha256Hex(bytes),
      size: bytes.byteLength,
      stagedRef: `memory:${path}`,
    })).sort((left, right) => compareUtf8(left.path, right.path));
    for (const previous of input.previousItems ?? []) {
      if (previous.kind !== "put" || !isConfigItemCovered(previous.path, input.profile) || bytesByPath.has(previous.path)) continue;
      const observed = await input.port.stat(previous.path);
      if (observed === null) confirmedAbsentPaths.add(previous.path);
      else if (observed.type !== "file") throw new Error(`projected config path is no longer a regular file: ${previous.path}`);
    }
    const scopeRevision = sha256Hex(new TextEncoder().encode(canonicalizeProtocolJson({
      profile: input.profile,
      communityPluginsHash: communityBytes ? sha256Hex(communityBytes) : null,
    })));
    return {
      observation: { status: "complete", scopeRevision, items },
      bytesByPath,
      manifestBytesByPluginId,
      allEnabledPluginIds: enabledObservation.ids,
      confirmedAbsentPaths,
    };
  } catch (error) {
    return unknown("本地路径或文件状态无法安全确认。", error);
  }
}

export async function captureLocalConfigSnapshot(input: {
  port: ConfigInspectionPort;
  profile: ConfigProfile;
  previousItems: readonly ManagedConfigItem[];
  repositoryId: string;
  descriptorHash: string;
  binding: ConfigTreeBinding;
  quietWindow: () => Promise<void>;
  syncPluginId?: string;
}): Promise<LocalConfigSnapshotResult> {
  let latest: ConfigWorkspaceScan | undefined;
  const stable = await captureStableConfigScan({
    scan: async () => {
      latest = await inspectConfigWorkspaceOnce(input);
      return latest.observation;
    },
    quietWindow: input.quietWindow,
  });
  if (stable.status !== "captured" || !latest || latest.observation.status !== "complete") {
    return {
      status: "retry",
      reason: stable.status === "retry" ? stable.reason : "scan-incomplete",
      ...(stable.status === "retry" && stable.error !== undefined ? { error: stable.error } : {}),
    };
  }
  const built = buildManagedConfigSnapshot({
    profile: input.profile,
    scan: stable,
    previousItems: input.previousItems,
    confirmedAbsentPaths: latest.confirmedAbsentPaths,
    enabledCommunityPlugins: portableEnabledPluginIds(latest.allEnabledPluginIds, input.profile, input.syncPluginId ?? "obsidian-s3-sync"),
    portablePluginManifestBytes: latest.manifestBytesByPluginId,
    syncPluginId: input.syncPluginId,
  });
  if (built.status !== "built") return { status: "retry", reason: built.reason, ...(built.paths ? { paths: built.paths } : {}) };
  const tree = materializeProtocolConfigTree(built, input.repositoryId, input.descriptorHash);
  const sizes = new Map(built.items.filter((item): item is Extract<ManagedConfigItem, { kind: "put" }> => item.kind === "put")
    .map((item) => [item.hash, item.size]));
  let treeHash: string;
  try {
    treeHash = buildConfigTreeObject("", tree, input.binding, sizes).hash;
  } catch (error) {
    return { status: "retry", reason: safeErrorMessage(error), error };
  }
  return {
    status: "captured",
    tree,
    treeHash,
    items: built.items,
    bytesByPath: new Map([...latest.bytesByPath].map(([path, bytes]) => [path, new Uint8Array(bytes)])),
    manifestBytesByPluginId: new Map([...latest.manifestBytesByPluginId].map(([id, bytes]) => [id, new Uint8Array(bytes)])),
    allEnabledPluginIds: [...latest.allEnabledPluginIds],
    scopeRevision: stable.scopeRevision,
  };
}

export async function discoverLocalPluginInventory(port: ConfigInspectionPort): Promise<LocalPluginInventoryEntry[]> {
  const root = await port.stat("plugins");
  if (root === null) return [];
  if (root.type !== "folder") throw new Error("plugins path is not a directory");
  const entries: LocalPluginInventoryEntry[] = [];
  for (const path of (await port.list("plugins")).sort(compareUtf8)) {
    const stat = await port.stat(path);
    if (stat?.type !== "folder" || parentPath(path) !== "plugins") continue;
    const directoryId = baseName(path);
    try {
      const bytes = await readOptionalRegularFile(port, `${path}/manifest.json`);
      if (!bytes) entries.push({ directoryId, error: "manifest.json is missing" });
      else entries.push({ directoryId, manifest: parsePluginManifest(bytes) });
    } catch (error) {
      entries.push({ directoryId, error: safeErrorMessage(error) });
    }
  }
  return entries;
}

async function inspectDirectory(
  port: ConfigInspectionPort,
  root: string,
  bytesByPath: Map<string, Uint8Array>,
  include: (path: string) => boolean = () => true,
): Promise<void> {
  const stat = await port.stat(root);
  if (stat === null) return;
  if (stat.type !== "folder") throw new Error(`config scope is not a directory: ${root}`);
  const children = await port.list(root);
  if (new Set(children).size !== children.length) throw new Error(`config directory contains duplicate entries: ${root}`);
  for (const child of children.sort(compareUtf8)) {
    if (parentPath(child) !== root || !child.startsWith(`${root}/`)) throw new Error(`config directory returned an invalid child: ${child}`);
    const childStat = await port.stat(child);
    if (!childStat || childStat.type === "symlink" || childStat.type === "other") throw new Error(`config path is not safely inspectable: ${child}`);
    if (childStat.type === "folder") await inspectDirectory(port, child, bytesByPath, include);
    else if (include(child)) await inspectFile(port, child, bytesByPath);
    if (bytesByPath.size > maximumConfigItems) throw new Error("config scan exceeds 100,000 items");
  }
}

async function inspectFile(port: ConfigInspectionPort, path: string, bytesByPath: Map<string, Uint8Array>): Promise<void> {
  const bytes = await readOptionalRegularFile(port, path);
  if (!bytes) return;
  const existing = bytesByPath.get(path);
  if (existing && sha256Hex(existing) !== sha256Hex(bytes)) throw new Error(`config scan has duplicate path bytes: ${path}`);
  bytesByPath.set(path, bytes);
}

async function readOptionalRegularFile(port: ConfigInspectionPort, path: string): Promise<Uint8Array | undefined> {
  const stat = await port.stat(path);
  if (stat === null) return undefined;
  if (stat.type !== "file") throw new Error(`config path is not a regular file: ${path}`);
  if (stat.size !== undefined && (!Number.isSafeInteger(stat.size) || stat.size < 0)) throw new Error(`config file size is invalid: ${path}`);
  const bytes = await port.read(path);
  if (stat.size !== undefined && bytes.byteLength !== stat.size) throw new Error(`config file changed during read: ${path}`);
  return new Uint8Array(bytes);
}

function unknown(reason: string, error?: unknown): ConfigWorkspaceScan {
  return {
    observation: { status: "unknown", reason, ...(error !== undefined ? { error } : {}) },
    bytesByPath: new Map(),
    manifestBytesByPluginId: new Map(),
    allEnabledPluginIds: [],
    confirmedAbsentPaths: new Set(),
  };
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}
