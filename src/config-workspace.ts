import { join } from "node:path";
import type { FileSystemAdapter } from "obsidian";
import { NodeConfigInspectionPort } from "../adapters/node-config-inspection-port";
import { NodeContentStagingAdapter } from "../adapters/node-content-staging-adapter";
import { NodeLocalFileAdapter } from "../adapters/node-local-file-adapter";
import { assessConfigTreeCompatibility, type ConfigTreeCompatibility } from "../core/config-compatibility";
import { diffManagedConfigItems } from "../core/config-diff";
import { ImmutableContentStaging } from "../core/content-staging";
import { captureLocalConfigSnapshot, discoverLocalPluginInventory, type LocalConfigSnapshotResult, type LocalPluginInventoryEntry } from "../core/config-local-inspection";
import { summarizeConfigPluginChanges } from "../core/config-ui-state";
import type { ManagedConfigItem } from "../core/config-snapshot-builder";
import type { ProtocolConfigTree } from "../core/config-tree";
import { LOCAL_STATE_CONTAINER, localStateRoot } from "../core/scope";
import type { PluginManifestInfo } from "../core/plugin-compatibility";
import type { ConfigProfile } from "../core/types";
import type { V1ConfigHead } from "./v1-service";
import type { ConfigTreeSourceView } from "./config-center-types";
import { compareUtf8 } from "../protocol/utf8";
import { DiagnosticError } from "../core/diagnostics";

export interface ConfigWorkspaceRuntime {
  port: NodeConfigInspectionPort;
  files: NodeLocalFileAdapter;
  staging: ImmutableContentStaging;
  statePrefix: string;
  recoveryLocation: string;
}

export function createConfigWorkspaceRuntime(input: {
  adapter: FileSystemAdapter;
  configDir: string;
  repositoryId: string;
}): ConfigWorkspaceRuntime {
  const vaultRoot = input.adapter.getBasePath();
  const configRoot = join(vaultRoot, ...input.configDir.split("/"));
  const stateRoot = join(configRoot, LOCAL_STATE_CONTAINER, input.repositoryId);
  return {
    port: new NodeConfigInspectionPort(configRoot),
    files: new NodeLocalFileAdapter({
      root: configRoot,
      platform: nodePlatform(),
      domain: "config",
      eventsObservable: false,
    }),
    staging: new ImmutableContentStaging(new NodeContentStagingAdapter(stateRoot)),
    statePrefix: `${LOCAL_STATE_CONTAINER}/${input.repositoryId}`,
    recoveryLocation: `${localStateRoot(input.configDir, input.repositoryId)}/recovery/config`,
  };
}

export async function captureLocalConfigSource(input: {
  runtime: ConfigWorkspaceRuntime;
  profile: ConfigProfile;
  previousItems: readonly ManagedConfigItem[];
  repositoryId: string;
  descriptorHash: string;
  configDir: string;
  historicalConfigDirs: string[];
  currentAppVersion: string;
  isDesktop: boolean;
  syncPluginId: string;
  quietWindow: () => Promise<void>;
}): Promise<{ result: LocalConfigSnapshotResult; inventory: LocalPluginInventoryEntry[]; source?: ConfigTreeSourceView }> {
  const [result, inventory] = await Promise.all([
    captureLocalConfigSnapshot({
      port: input.runtime.port,
      profile: input.profile,
      previousItems: input.previousItems,
      repositoryId: input.repositoryId,
      descriptorHash: input.descriptorHash,
      binding: { configDir: input.configDir, historicalConfigDirs: input.historicalConfigDirs },
      quietWindow: input.quietWindow,
      syncPluginId: input.syncPluginId,
    }),
    discoverLocalPluginInventory(input.runtime.port),
  ]);
  if (result.status !== "captured") return { result, inventory };
  const localManifests = inventoryManifestMap(inventory);
  const compatibility = assessConfigTreeCompatibility({
    tree: { profile: result.tree.profile, enabledCommunityPlugins: result.tree.enabledCommunityPlugins, items: result.items },
    currentAppVersion: input.currentAppVersion,
    isDesktop: input.isDesktop,
    syncPluginId: input.syncPluginId,
    stagedManifestBytes: manifestBytesByPath(result.tree, result.bytesByPath),
    localPluginManifests: localManifests,
    localPluginDirectories: inventory.map((entry) => entry.directoryId),
    localEnabledPluginIds: result.allEnabledPluginIds,
  });
  return {
    result,
    inventory,
    source: {
      id: "local",
      kind: "local",
      label: "本地 ConfigTree",
      treeHash: result.treeHash,
      versionIds: [],
      writerIds: [],
      tree: result.tree,
      items: result.items.map((item) => ({ ...item })),
      bytesByPath: cloneBytesMap(result.bytesByPath),
      compatibility,
      pluginChanges: [],
    },
  };
}

export async function buildRemoteConfigSources(input: {
  runtime: ConfigWorkspaceRuntime;
  heads: readonly V1ConfigHead[];
  localItems: readonly ManagedConfigItem[];
  inventory: readonly LocalPluginInventoryEntry[];
  allLocalEnabledPluginIds: readonly string[];
  currentAppVersion: string;
  isDesktop: boolean;
  syncPluginId: string;
}): Promise<ConfigTreeSourceView[]> {
  const grouped = new Map<string, V1ConfigHead[]>();
  for (const head of input.heads) {
    const values = grouped.get(head.treeHash) ?? [];
    values.push(head);
    grouped.set(head.treeHash, values);
  }
  const localManifests = inventoryManifestMap(input.inventory);
  const sources: ConfigTreeSourceView[] = [];
  for (const [treeHash, heads] of [...grouped].sort(([left], [right]) => compareUtf8(left, right))) {
    const head = heads[0];
    if (heads.some((candidate) => !sameTree(candidate.tree, head.tree))) {
      throw new DiagnosticError(
        "CONFIG_TREE_HASH_COLLISION",
        "integrity",
        "equal ConfigTree hashes produced different objects",
      );
    }
    const bytesByPath = cloneBytesMap(head.bytesByPath);
    const items = await stageRemoteTreeItems(input.runtime, head.tree, bytesByPath);
    const compatibility = assessConfigTreeCompatibility({
      tree: { profile: head.tree.profile, enabledCommunityPlugins: head.tree.enabledCommunityPlugins, items },
      currentAppVersion: input.currentAppVersion,
      isDesktop: input.isDesktop,
      syncPluginId: input.syncPluginId,
      stagedManifestBytes: manifestBytesByPath(head.tree, bytesByPath),
      localPluginManifests: localManifests,
      localPluginDirectories: input.inventory.map((entry) => entry.directoryId),
      localEnabledPluginIds: input.allLocalEnabledPluginIds,
    });
    const diff = diffManagedConfigItems(input.localItems, items);
    sources.push({
      id: `remote:${treeHash}`,
      kind: "remote",
      label: `远端 ConfigTree ${shortHash(treeHash)}`,
      treeHash,
      versionIds: heads.map((candidate) => candidate.versionId).sort(compareUtf8),
      writerIds: [...new Set(heads.map((candidate) => candidate.writerId))].sort(compareUtf8),
      tree: structuredClone(head.tree),
      items,
      bytesByPath,
      compatibility,
      pluginChanges: summarizeConfigPluginChanges({
        diff,
        manifests: compatibility.status === "compatible" ? compatibility.manifests : {},
        sourceWriters: heads.map((candidate) => candidate.writerId),
        compatibilityReasons: compatibility.status === "incompatible" ? compatibility.reasons : [],
      }),
    });
  }
  return sources;
}

export async function stageConfigTreeBytes(
  runtime: ConfigWorkspaceRuntime,
  tree: ProtocolConfigTree,
  bytesByPath: ReadonlyMap<string, Uint8Array>,
): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  for (const item of tree.items) {
    if (item.kind !== "put") continue;
    if (!item.blobHash || item.size === undefined) {
      throw new DiagnosticError(
        "CONFIG_TREE_BLOB_REFERENCE_MISSING",
        "integrity",
        "ConfigTree put has no Blob reference",
      );
    }
    const bytes = bytesByPath.get(item.path);
    if (!bytes) {
      throw new DiagnosticError(
        "CONFIG_TREE_BLOB_BYTES_MISSING",
        "integrity",
        "ConfigTree Blob bytes are not available",
      );
    }
    const staged = await runtime.staging.stage(oneChunk(bytes), item.size);
    if (staged.hash !== item.blobHash || staged.size !== item.size) {
      throw new DiagnosticError(
        "CONFIG_TREE_STAGED_BLOB_MISMATCH",
        "integrity",
        "staged ConfigTree Blob does not match its verified identity",
      );
    }
    refs.set(item.path, `${runtime.statePrefix}/${staged.ref}`);
  }
  return refs;
}

export function treeManagedItems(tree: ProtocolConfigTree, stagedRefs: ReadonlyMap<string, string>): ManagedConfigItem[] {
  return tree.items.map((item): ManagedConfigItem => {
    if (item.kind === "delete") return { path: item.path, kind: "delete" };
    if (!item.blobHash || item.size === undefined) {
      throw new DiagnosticError(
        "CONFIG_TREE_BLOB_REFERENCE_MISSING",
        "integrity",
        "ConfigTree put has no Blob reference",
      );
    }
    const stagedRef = stagedRefs.get(item.path);
    if (!stagedRef) {
      throw new DiagnosticError(
        "CONFIG_TREE_STAGED_REFERENCE_MISSING",
        "integrity",
        "ConfigTree put has not been staged",
      );
    }
    return { path: item.path, kind: "put", hash: item.blobHash, size: item.size, stagedRef };
  });
}

export function inventoryManifestMap(inventory: readonly LocalPluginInventoryEntry[]): Map<string, PluginManifestInfo> {
  return new Map(inventory.flatMap((entry) => entry.manifest ? [[entry.directoryId, entry.manifest] as const] : []));
}

export function compatibilityReasons(compatibility: ConfigTreeCompatibility): string[] {
  return compatibility.status === "incompatible" ? [...compatibility.reasons] : [];
}

async function stageRemoteTreeItems(
  runtime: ConfigWorkspaceRuntime,
  tree: ProtocolConfigTree,
  bytesByPath: ReadonlyMap<string, Uint8Array>,
): Promise<ManagedConfigItem[]> {
  return treeManagedItems(tree, await stageConfigTreeBytes(runtime, tree, bytesByPath));
}

function manifestBytesByPath(tree: ProtocolConfigTree, bytesByPath: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
  const result = new Map<string, Uint8Array>();
  for (const id of tree.profile.pluginPackages) {
    const path = `plugins/${id}/manifest.json`;
    const bytes = bytesByPath.get(path);
    if (bytes) result.set(path, bytes);
  }
  return result;
}

function cloneBytesMap(source: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
  return new Map([...source].map(([path, bytes]) => [path, new Uint8Array(bytes)]));
}

function sameTree(left: ProtocolConfigTree, right: ProtocolConfigTree): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> { yield new Uint8Array(bytes); }

function shortHash(hash: string): string { return `${hash.slice(0, 8)}...${hash.slice(-6)}`; }

function nodePlatform(): "windows" | "macos" | "linux" {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}
