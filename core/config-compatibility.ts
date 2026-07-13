import { parsePluginManifest } from "./plugin-manifest";
import { comparePlainVersion, isPortablePluginCompatible, type PluginManifestInfo } from "./plugin-compatibility";
import { validateConfigProfile } from "./config-profile";
import { vaultPathCaseFoldKey } from "./path";
import type { ManagedConfigItem } from "./config-snapshot-builder";
import type { ConfigProfile } from "./types";

export interface PortableConfigSnapshotView {
  profile: ConfigProfile;
  enabledCommunityPlugins: string[];
  items: ManagedConfigItem[];
}

export type ConfigTreeCompatibility =
  | { status: "compatible"; requiresHighRiskConfirmation: boolean; risks: ConfigTreeRisk[]; manifests: Record<string, PluginManifestInfo> }
  | { status: "incompatible"; reasons: string[]; risks: ConfigTreeRisk[] };

export interface ConfigTreeRisk {
  kind: "plugin-code" | "new-plugin" | "plugin-data";
  pluginId: string;
  paths: string[];
}

export function assessConfigTreeCompatibility(input: {
  tree: PortableConfigSnapshotView;
  currentAppVersion: string;
  isDesktop: boolean;
  syncPluginId: string;
  stagedManifestBytes: ReadonlyMap<string, Uint8Array>;
  localPluginManifests: ReadonlyMap<string, PluginManifestInfo>;
  localPluginDirectories?: readonly string[];
}): ConfigTreeCompatibility {
  const reasons = validateConfigProfile(input.tree.profile, input.syncPluginId);
  const risks: ConfigTreeRisk[] = [];
  if (!input.tree.profile.minimumTargetAppVersion) reasons.push("missing minimumTargetAppVersion");
  else {
    try {
      if (comparePlainVersion(input.currentAppVersion, input.tree.profile.minimumTargetAppVersion) < 0) reasons.push("current app is below minimumTargetAppVersion");
    } catch { reasons.push("app version is invalid"); }
  }
  const portable = new Set(input.tree.profile.portablePluginIds);
  if (input.tree.enabledCommunityPlugins.some((id) => !portable.has(id))) reasons.push("enabled plugin is not portable");
  const syncAlias = vaultPathCaseFoldKey(input.syncPluginId);
  for (const array of [input.tree.profile.portablePluginIds, input.tree.profile.pluginPackages, input.tree.profile.pluginData, input.tree.enabledCommunityPlugins]) {
    if (array.some((id) => vaultPathCaseFoldKey(id) === syncAlias)) reasons.push("sync plugin appears in portable ConfigTree");
  }
  const portableAliases = new Map(input.tree.profile.portablePluginIds.map((id) => [vaultPathCaseFoldKey(id), id]));
  for (const localId of input.localPluginDirectories ?? []) {
    const portableId = portableAliases.get(vaultPathCaseFoldKey(localId));
    if (portableId && portableId !== localId) reasons.push(`local plugin directory aliases portable plugin ${portableId}`);
  }

  const manifests: Record<string, PluginManifestInfo> = {};
  const packagePuts = new Map<string, ManagedConfigItem[]>();
  for (const id of input.tree.profile.pluginPackages) {
    const puts = input.tree.items.filter((item) => item.kind === "put" && item.path.startsWith(`plugins/${id}/`));
    packagePuts.set(id, puts);
    if (puts.length === 0) continue;
    const manifestPath = `plugins/${id}/manifest.json`;
    const manifestBytes = input.stagedManifestBytes.get(manifestPath);
    if (!puts.some((item) => item.path === manifestPath) || !manifestBytes) {
      reasons.push(`portable package ${id} has no staged manifest.json put`);
      continue;
    }
    try {
      const manifest = parsePluginManifest(manifestBytes);
      manifests[id] = manifest;
      if (!isPortablePluginCompatible(manifest, id, input.tree.profile.minimumTargetAppVersion!, input.isDesktop)) {
        reasons.push(`portable package ${id} is incompatible with the declared target`);
      }
    } catch (error) {
      reasons.push(`portable package ${id} manifest is invalid: ${errorMessage(error)}`);
    }
    const codePaths = puts.filter((item) => /\.(?:js|css)$/i.test(item.path)).map((item) => item.path).sort();
    if (codePaths.length > 0) risks.push({ kind: "plugin-code", pluginId: id, paths: codePaths });
    if (!input.localPluginManifests.has(id)) risks.push({ kind: "new-plugin", pluginId: id, paths: puts.map((item) => item.path).sort() });
  }

  const dataPutIds = input.tree.profile.pluginData.filter((id) => input.tree.items.some((item) => item.kind === "put" && item.path === `plugins/${id}/data.json`));
  for (const id of new Set([...input.tree.enabledCommunityPlugins, ...dataPutIds])) {
    const hasRemotePackage = (packagePuts.get(id)?.length ?? 0) > 0;
    const manifest = hasRemotePackage ? manifests[id] : input.localPluginManifests.get(id);
    if (!manifest || !isPortablePluginCompatible(manifest, id, input.currentAppVersion, input.isDesktop)) {
      reasons.push(`enabled or data-managed plugin ${id} has no compatible package on this device`);
    }
  }
  for (const id of input.tree.profile.pluginData) {
    const paths = input.tree.items.filter((item) => item.kind === "put" && item.path === `plugins/${id}/data.json`).map((item) => item.path);
    if (paths.length > 0) risks.push({ kind: "plugin-data", pluginId: id, paths });
  }
  return reasons.length > 0
    ? { status: "incompatible", reasons: [...new Set(reasons)], risks }
    : { status: "compatible", requiresHighRiskConfirmation: risks.length > 0, risks, manifests };
}

export function detectSensitivePluginData(bytes: Uint8Array): { indicators: string[]; limitation: string } {
  const source = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const foldedSource = source.toLowerCase();
  const indicators = ["password", "secret", "token", "api-key", "apikey", "credential"]
    .filter((word) => foldedSource.includes(word));
  return {
    indicators,
    limitation: "启发式检查可能漏报；plugin data 将以明文存储在远端。",
  };
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
