import { isValidSequence, utf8ByteLength } from "./limits";
import { defaultCaseFold151, normalizeNfc151 } from "./unicode";

export interface ProtocolCommit {
  protocol: 1;
  repositoryId: string;
  descriptorHash: string;
  writerId: string;
  sequence: string;
  previousCommitHash: string | null;
  createdAt: string;
  channel: "vault" | "config";
  kind: "change" | "bootstrap" | "conflict-resolution" | "parent-reduction";
  changeChunkHashes: string[];
  clientVersion: string;
}

export interface ProtocolChunk {
  protocol: 1;
  repositoryId: string;
  descriptorHash: string;
  channel: "vault" | "config";
  chunkIndex: number;
  chunkCount: number;
  mutations: Array<{ path?: string; parents: string[] }>;
}

export type ProtocolViolation =
  | "descriptor-hash-mismatch"
  | "invalid-sequence"
  | "previous-commit-chain-shape"
  | "chunk-count-mismatch"
  | "chunk-hash-order-mismatch"
  | "chunk-index-not-contiguous"
  | "chunk-channel-mismatch"
  | "chunk-repository-mismatch"
  | "parents-not-canonical"
  | "vault-mutations-not-canonical"
  | "duplicate-vault-path"
  | "config-commit-shape"
  | "bootstrap-parents"
  | "change-parents"
  | "conflict-resolution-parents"
  | "parent-reduction-shape"
  | "parent-reduction-parents";

export type ConfigDeleteViolation =
  | "root-config-delete"
  | "pending-parent-tree"
  | "config-delete-not-managed-by-parent";

export interface ConfigTreeForProfile {
  profile: {
    baseFiles: string[];
    syncThemes: boolean;
    syncSnippets: boolean;
    portablePluginIds: string[];
    pluginPackages: string[];
    pluginData: string[];
  };
  enabledCommunityPlugins: string[];
  items: Array<{ path: string; kind: "put" | "delete" }>;
}

export type ConfigTreeProfileViolation =
  | "config-array-not-canonical"
  | "config-case-alias"
  | "plugin-scope-not-portable"
  | "config-item-path-duplicate"
  | "config-item-not-profiled";

export type PathViolation =
  | "path-not-nfc"
  | "path-invalid-segment"
  | "path-control-character"
  | "path-too-long";

export function validateCommitEnvelope(
  descriptorHash: string,
  commit: ProtocolCommit,
  chunks: ProtocolChunk[],
  chunkHashes: string[],
): ProtocolViolation[] {
  const violations: ProtocolViolation[] = [];
  if (!isValidSequence(commit.sequence)) violations.push("invalid-sequence");
  if (
    (commit.sequence === "00000000000000000001" && commit.previousCommitHash !== null) ||
    (commit.sequence !== "00000000000000000001" && commit.previousCommitHash === null)
  ) {
    violations.push("previous-commit-chain-shape");
  }
  if (commit.descriptorHash !== descriptorHash) violations.push("descriptor-hash-mismatch");
  if (chunks.length !== commit.changeChunkHashes.length) violations.push("chunk-count-mismatch");
  if (
    chunkHashes.length !== commit.changeChunkHashes.length ||
    chunkHashes.some((hash, index) => hash !== commit.changeChunkHashes[index])
  ) {
    violations.push("chunk-hash-order-mismatch");
  }

  const seenPaths = new Set<string>();
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk.repositoryId !== commit.repositoryId) violations.push("chunk-repository-mismatch");
    if (chunk.descriptorHash !== descriptorHash) violations.push("descriptor-hash-mismatch");
    if (
      chunk.channel !== commit.channel ||
      chunk.chunkIndex !== index ||
      chunk.chunkCount !== chunks.length
    ) {
      violations.push(
        chunk.channel !== commit.channel ? "chunk-channel-mismatch" : "chunk-index-not-contiguous",
      );
    }
    if (commit.channel === "vault") {
      if (!isUtf8SortedUnique(chunk.mutations.map((mutation) => mutation.path ?? ""))) {
        violations.push("vault-mutations-not-canonical");
      }
      for (const mutation of chunk.mutations) {
        if (mutation.path && seenPaths.has(mutation.path)) violations.push("duplicate-vault-path");
        if (mutation.path) seenPaths.add(mutation.path);
      }
    }
  }

  const mutations = chunks.flatMap((chunk) => chunk.mutations);
  if (mutations.some((mutation) => !isUtf8SortedUnique(mutation.parents))) {
    violations.push("parents-not-canonical");
  }
  if (commit.channel === "config" && (chunks.length !== 1 || mutations.length !== 1)) {
    violations.push("config-commit-shape");
  }
  if (commit.kind === "bootstrap" && mutations.some((mutation) => mutation.parents.length !== 0)) {
    violations.push("bootstrap-parents");
  }
  if (commit.kind === "change" && mutations.some((mutation) => mutation.parents.length > 1024)) {
    violations.push("change-parents");
  }
  if (
    commit.kind === "conflict-resolution" &&
    mutations.some((mutation) => mutation.parents.length < 1 || mutation.parents.length > 1024)
  ) {
    violations.push("conflict-resolution-parents");
  }
  if (commit.kind === "parent-reduction") {
    if (chunks.length !== 1 || mutations.length !== 1) violations.push("parent-reduction-shape");
    if (mutations.some((mutation) => mutation.parents.length < 2 || mutation.parents.length > 1024)) {
      violations.push("parent-reduction-parents");
    }
  }
  return [...new Set(violations)];
}

const utf8Encoder = new TextEncoder();

export function isUtf8SortedUnique(values: string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (compareUtf8(values[index - 1], values[index]) >= 0) return false;
  }
  return true;
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = utf8Encoder.encode(left);
  const rightBytes = utf8Encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}

function isCaseFoldUnique(values: string[]): boolean {
  const keys = new Set<string>();
  for (const value of values) {
    const key = defaultCaseFold151(normalizeNfc151(value));
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

export interface ConfigTreeForLineage {
  items: Array<{ path: string; kind: "put" | "delete" }>;
}

export function validateConfigDeleteLineage(
  parents: string[],
  tree: ConfigTreeForLineage,
  resolvedParents: ReadonlyMap<string, ConfigTreeForLineage>,
): ConfigDeleteViolation[] {
  const deletes = tree.items.filter((item) => item.kind === "delete");
  if (deletes.length === 0) return [];
  if (parents.length === 0) return ["root-config-delete"];
  const parentTrees = parents.map((parent) => resolvedParents.get(parent));
  if (parentTrees.some((parent) => !parent)) return ["pending-parent-tree"];
  const violations: ConfigDeleteViolation[] = [];
  for (const deleted of deletes) {
    const managedByParent = parentTrees.some((parent) =>
      parent?.items.some((item) => item.kind === "put" && item.path === deleted.path),
    );
    if (!managedByParent) violations.push("config-delete-not-managed-by-parent");
  }
  return [...new Set(violations)];
}

export function validateConfigTreeProfile(tree: ConfigTreeForProfile): ConfigTreeProfileViolation[] {
  const violations: ConfigTreeProfileViolation[] = [];
  const profileArrays = [
    tree.profile.baseFiles,
    tree.profile.portablePluginIds,
    tree.profile.pluginPackages,
    tree.profile.pluginData,
    tree.enabledCommunityPlugins,
  ];
  if (profileArrays.some((values) => !isUtf8SortedUnique(values))) {
    violations.push("config-array-not-canonical");
  }
  if (profileArrays.some((values) => !isCaseFoldUnique(values))) {
    violations.push("config-case-alias");
  }
  const portable = new Set(tree.profile.portablePluginIds);
  if (
    [...tree.profile.pluginPackages, ...tree.profile.pluginData, ...tree.enabledCommunityPlugins].some(
      (pluginId) => !portable.has(pluginId),
    )
  ) {
    violations.push("plugin-scope-not-portable");
  }
  const paths = tree.items.map((item) => item.path);
  if (!isUtf8SortedUnique(paths)) violations.push("config-item-path-duplicate");
  if (tree.items.some((item) => !isItemCoveredByProfile(item.path, tree.profile))) {
    violations.push("config-item-not-profiled");
  }
  return [...new Set(violations)];
}

function isItemCoveredByProfile(path: string, profile: ConfigTreeForProfile["profile"]): boolean {
  if (profile.baseFiles.includes(path) && !path.includes("/")) return true;
  if (profile.syncThemes && path.startsWith("themes/") && path.length > "themes/".length) return true;
  if (profile.syncSnippets && path.startsWith("snippets/") && path.length > "snippets/".length) {
    return true;
  }
  const pluginMatch = /^plugins\/([^/]+)\/(.+)$/.exec(path);
  if (!pluginMatch) return false;
  const [, pluginId, relativePath] = pluginMatch;
  const dataPath = relativePath === "data.json";
  const packageCovered = profile.pluginPackages.includes(pluginId) && !dataPath;
  const dataCovered = profile.pluginData.includes(pluginId) && dataPath;
  return packageCovered !== dataCovered;
}

export function validateProtocolPath(path: string): PathViolation[] {
  const violations: PathViolation[] = [];
  if (normalizeNfc151(path) !== path) violations.push("path-not-nfc");
  if (utf8ByteLength(path) > 1024) violations.push("path-too-long");
  if (
    /^[\/]|[\\]|\/\/|\/$/.test(path) ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    violations.push("path-invalid-segment");
  }
  if (/[\u0000-\u001f\u007f]/.test(path)) violations.push("path-control-character");
  return violations;
}
