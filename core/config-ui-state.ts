import type { PluginManifestInfo } from "./plugin-compatibility";
import { configItemCoverageSources, validateConfigProfile } from "./config-profile";
import type { ConfigDiffEntry } from "./config-diff";
import { configProfileTransition, type ManagedConfigItem } from "./config-snapshot-builder";
import type { ConfigProfile } from "./types";

export type ConfigUiStatus =
  | "disabled"
  | "unbound"
  | "ready"
  | "local-changes"
  | "pending"
  | "conflict"
  | "incompatible"
  | "apply-failed"
  | "recovery-required"
  | "load-failed";

export interface ConfigRegisterUiState {
  status: ConfigUiStatus;
  message: string;
  remoteHeads: string[];
  pendingVersions: string[];
  invalidVersions: string[];
}

export interface ConfigProfileTransitionSummary {
  stopManaging: string[];
  propagateDeletes: string[];
  stillManaged: string[];
  violations: string[];
}

export interface ConfigMergeSource {
  id: string;
  profile: ConfigProfile;
  enabledCommunityPlugins: string[];
  items: ManagedConfigItem[];
}

export interface ConfigMergeCandidate {
  profile: ConfigProfile;
  enabledCommunityPlugins: string[];
  items: ManagedConfigItem[];
}

export interface ConfigPluginChange {
  pluginId: string;
  version?: string;
  sourceWriters: string[];
  codePaths: string[];
  dataPaths: string[];
  compatibility: "compatible" | "incompatible" | "unknown";
  compatibilityReasons: string[];
}

export interface ConfigTrustRequirements {
  pluginCode: boolean;
  pluginData: boolean;
  loadedPlugins: boolean;
  newPlugins: boolean;
}

export function deriveConfigRegisterUiState(input: {
  enabled: boolean;
  repositoryBound: boolean;
  remoteDisposition: "empty" | "resolved" | "conflict" | "pending" | "invalid";
  remoteHeads?: readonly string[];
  pendingVersions?: readonly string[];
  invalidVersions?: readonly string[];
  localTreeHash?: string;
  projectedTreeHash?: string | null;
  compatible?: boolean;
  applyFailure?: "rolled-back" | "recovery-required";
  loadError?: string;
}): ConfigRegisterUiState {
  const remoteHeads = sortedUnique(input.remoteHeads ?? []);
  const pendingVersions = sortedUnique(input.pendingVersions ?? []);
  const invalidVersions = sortedUnique(input.invalidVersions ?? []);
  if (!input.enabled) return state("disabled", "配置同步已关闭。", remoteHeads, pendingVersions, invalidVersions);
  if (!input.repositoryBound) return state("unbound", "尚未选择 v1 仓库。", remoteHeads, pendingVersions, invalidVersions);
  if (input.applyFailure === "recovery-required") {
    return state("recovery-required", "配置批次需要从恢复位置继续处理。", remoteHeads, pendingVersions, invalidVersions);
  }
  if (input.applyFailure === "rolled-back") {
    return state("apply-failed", "配置应用失败，已回滚并保留恢复副本。", remoteHeads, pendingVersions, invalidVersions);
  }
  if (input.loadError) return state("load-failed", input.loadError, remoteHeads, pendingVersions, invalidVersions);
  if (input.remoteDisposition === "pending") {
    return state("pending", "配置快照仍在等待父版本、ConfigTree 或 Blob。", remoteHeads, pendingVersions, invalidVersions);
  }
  if (input.remoteDisposition === "invalid") {
    return state("incompatible", "远端配置寄存器包含无效版本，不能应用。", remoteHeads, pendingVersions, invalidVersions);
  }
  if (input.remoteDisposition === "conflict") {
    return state("conflict", "远端包含不同的并发 ConfigTree，需要显式选树或合并。", remoteHeads, pendingVersions, invalidVersions);
  }
  if (input.compatible === false) {
    return state("incompatible", "目标 ConfigTree 与当前设备或 Obsidian 版本不兼容。", remoteHeads, pendingVersions, invalidVersions);
  }
  if (input.localTreeHash !== undefined && input.projectedTreeHash !== undefined
    && input.localTreeHash !== input.projectedTreeHash) {
    return state("local-changes", "本地配置已偏离已投影 ConfigTree。", remoteHeads, pendingVersions, invalidVersions);
  }
  return state("ready", input.remoteDisposition === "empty" ? "远端尚无配置快照。" : "配置快照已验证，可预览。", remoteHeads, pendingVersions, invalidVersions);
}

export function summarizeConfigProfileTransition(input: {
  previousProfile: ConfigProfile;
  nextProfile: ConfigProfile;
  previousItems: readonly ManagedConfigItem[];
  explicitDeletePaths?: readonly string[];
  syncPluginId?: string;
}): ConfigProfileTransitionSummary {
  const transition = configProfileTransition(input);
  const deletes = sortedUnique(input.explicitDeletePaths ?? []);
  const propagateDeletes = deletes.filter((path) => configItemCoverageSources(path, input.nextProfile).length === 1);
  const stopManaging = transition.stopManaging.filter((path) => !propagateDeletes.includes(path));
  return {
    stopManaging,
    propagateDeletes,
    stillManaged: transition.stillManaged,
    violations: validateConfigProfile(input.nextProfile, input.syncPluginId),
  };
}

export function buildMultiSourceConfigMerge(input: {
  sources: readonly ConfigMergeSource[];
  selections: Readonly<Record<string, string | "stop-managing">>;
  profileSourceId: string;
  enabledSourceId: string;
  syncPluginId?: string;
}): ConfigMergeCandidate {
  if (input.sources.length < 2) throw new Error("config merge needs at least two sources");
  const byId = new Map<string, ConfigMergeSource>();
  for (const source of input.sources) {
    if (!source.id || byId.has(source.id)) throw new Error("config merge source identity is invalid");
    assertUniqueItems(source.items);
    byId.set(source.id, source);
  }
  const profileSource = byId.get(input.profileSourceId);
  const enabledSource = byId.get(input.enabledSourceId);
  if (!profileSource || !enabledSource) throw new Error("config merge profile or enablement source is missing");
  const profile = structuredClone(profileSource.profile);
  const violations = validateConfigProfile(profile, input.syncPluginId);
  if (violations.length > 0) throw new Error(`config merge profile is invalid: ${violations.join(",")}`);

  const paths = sortedUnique(input.sources.flatMap((source) => source.items.map((item) => item.path)));
  const items: ManagedConfigItem[] = [];
  for (const path of paths) {
    const selection = input.selections[path];
    if (!selection) throw new Error(`config merge needs an explicit selection for ${path}`);
    if (selection === "stop-managing") continue;
    const source = byId.get(selection);
    const item = source?.items.find((candidate) => candidate.path === path);
    if (!item) throw new Error(`selected config merge source has no item for ${path}`);
    if (configItemCoverageSources(path, profile).length !== 1) {
      throw new Error(`selected config merge profile does not cover ${path}`);
    }
    items.push({ ...item });
  }
  assertUniqueItems(items);
  const enabledCommunityPlugins = sortedUnique(enabledSource.enabledCommunityPlugins);
  const portable = new Set(profile.portablePluginIds);
  if (enabledCommunityPlugins.some((id) => !portable.has(id))) {
    throw new Error("config merge enablement contains a device-local plugin");
  }
  return { profile, enabledCommunityPlugins, items };
}

export function summarizeConfigPluginChanges(input: {
  diff: readonly ConfigDiffEntry[];
  manifests: Readonly<Record<string, PluginManifestInfo>>;
  sourceWriters: readonly string[];
  compatibilityReasons?: readonly string[];
}): ConfigPluginChange[] {
  const byPlugin = new Map<string, { codePaths: string[]; dataPaths: string[] }>();
  for (const entry of input.diff) {
    const match = /^plugins\/([^/]+)\/(.+)$/.exec(entry.path);
    if (!match || (!entry.codeChange && !entry.sensitive)) continue;
    const current = byPlugin.get(match[1]) ?? { codePaths: [], dataPaths: [] };
    if (entry.codeChange) current.codePaths.push(entry.path);
    if (entry.sensitive) current.dataPaths.push(entry.path);
    byPlugin.set(match[1], current);
  }
  const reasons = [...new Set(input.compatibilityReasons ?? [])];
  return [...byPlugin.entries()].sort(([left], [right]) => compareUtf8(left, right)).map(([pluginId, paths]) => {
    const manifest = input.manifests[pluginId];
    const relevantReasons = reasons.filter((reason) => reason.includes(pluginId));
    return {
      pluginId,
      ...(manifest ? { version: manifest.version } : {}),
      sourceWriters: sortedUnique(input.sourceWriters),
      codePaths: paths.codePaths.sort(compareUtf8),
      dataPaths: paths.dataPaths.sort(compareUtf8),
      compatibility: relevantReasons.length > 0 ? "incompatible" : manifest ? "compatible" : "unknown",
      compatibilityReasons: relevantReasons,
    };
  });
}

export function configTrustRequirements(input: {
  diff: readonly ConfigDiffEntry[];
  loadedPluginIds?: readonly string[];
  newPluginIds?: readonly string[];
}): ConfigTrustRequirements {
  const loaded = new Set(input.loadedPluginIds ?? []);
  return {
    pluginCode: input.diff.some((entry) => entry.codeChange),
    pluginData: input.diff.some((entry) => entry.sensitive),
    loadedPlugins: input.diff.some((entry) => {
      const pluginId = /^plugins\/([^/]+)\//.exec(entry.path)?.[1];
      return pluginId !== undefined && loaded.has(pluginId) && entry.kind !== "stop-managing" && entry.kind !== "unchanged";
    }),
    newPlugins: (input.newPluginIds?.length ?? 0) > 0,
  };
}

function state(
  status: ConfigUiStatus,
  message: string,
  remoteHeads: string[],
  pendingVersions: string[],
  invalidVersions: string[],
): ConfigRegisterUiState {
  return { status, message, remoteHeads, pendingVersions, invalidVersions };
}

function assertUniqueItems(items: readonly ManagedConfigItem[]): void {
  if (new Set(items.map((item) => item.path)).size !== items.length) throw new Error("config merge source contains duplicate paths");
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareUtf8);
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}
