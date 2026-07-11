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
  | "invalid-created-at"
  | "invalid-client-version"
  | "previous-commit-chain-shape"
  | "chunk-count-mismatch"
  | "chunk-hash-order-mismatch"
  | "duplicate-chunk-hash"
  | "chunk-index-not-contiguous"
  | "chunk-channel-mismatch"
  | "chunk-repository-mismatch"
  | "parents-not-canonical"
  | "vault-mutations-not-canonical"
  | "vault-path-invalid"
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
    minimumTargetAppVersion?: string;
  };
  enabledCommunityPlugins: string[];
  items: Array<{ path: string; kind: "put" | "delete" }>;
}

export type ConfigTreeProfileViolation =
  | "config-array-not-canonical"
  | "config-case-alias"
  | "base-file-invalid"
  | "minimum-app-version-invalid"
  | "plugin-id-invalid"
  | "plugin-scope-not-portable"
  | "config-item-path-duplicate"
  | "config-item-path-invalid"
  | "config-put-case-alias"
  | "config-put-path-prefix-conflict"
  | "config-item-not-profiled";

export type PathViolation =
  | "path-not-nfc"
  | "path-invalid-segment"
  | "path-control-character"
  | "path-too-long";

export type PluginIdViolation =
  | "plugin-id-not-nfc"
  | "plugin-id-invalid-shape"
  | "plugin-id-control-character"
  | "plugin-id-too-long"
  | "plugin-id-reserved-name";

export interface RepositoryDescriptorForSemantics {
  configDir: string;
  historicalConfigDirs: string[];
}

export type RepositoryDescriptorViolation =
  | "descriptor-config-dir-invalid"
  | "descriptor-historical-dir-invalid"
  | "descriptor-historical-dirs-not-canonical"
  | "descriptor-historical-dir-case-alias";

export type ConfigTreeExcludedPathViolation = "config-item-in-excluded-root";

export function validateCommitEnvelope(
  descriptorHash: string,
  commit: ProtocolCommit,
  chunks: ProtocolChunk[],
  chunkHashes: string[],
): ProtocolViolation[] {
  const violations = validateCommitFields(commit);
  
  if (commit.descriptorHash !== descriptorHash) violations.push("descriptor-hash-mismatch");
  if (chunks.length !== commit.changeChunkHashes.length) violations.push("chunk-count-mismatch");
  if (
    chunkHashes.length !== commit.changeChunkHashes.length ||
    chunkHashes.some((hash, index) => hash !== commit.changeChunkHashes[index])
  ) {
    violations.push("chunk-hash-order-mismatch");
  }
  if (new Set(commit.changeChunkHashes).size !== commit.changeChunkHashes.length) {
    violations.push("duplicate-chunk-hash");
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
      for (const violation of validateChangeChunkObject(chunk)) violations.push(violation);
      for (const mutation of chunk.mutations) {
        if (mutation.path && seenPaths.has(mutation.path)) violations.push("duplicate-vault-path");
        if (mutation.path) seenPaths.add(mutation.path);
      }
    }
  }

  const mutations = chunks.flatMap((chunk) => chunk.mutations);
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

export function validateCommitFields(commit: ProtocolCommit): ProtocolViolation[] {
  const violations: ProtocolViolation[] = [];
  if (!isValidSequence(commit.sequence)) violations.push("invalid-sequence");
  if (!isValidCreatedAt(commit.createdAt)) violations.push("invalid-created-at");
  if (!isValidClientVersion(commit.clientVersion)) violations.push("invalid-client-version");
  if (
    (commit.sequence === "00000000000000000001" && commit.previousCommitHash !== null) ||
    (commit.sequence !== "00000000000000000001" && commit.previousCommitHash === null)
  ) {
    violations.push("previous-commit-chain-shape");
  }
  return [...new Set(violations)];
}

export function validateChangeChunkObject(chunk: ProtocolChunk): ProtocolViolation[] {
  const violations: ProtocolViolation[] = [];
  if (chunk.channel === "vault") {
    if (!isUtf8SortedUnique(chunk.mutations.map((mutation) => mutation.path ?? ""))) {
      violations.push("vault-mutations-not-canonical");
    }
    if (chunk.mutations.some((mutation) => !mutation.path || validateProtocolPath(mutation.path).length > 0)) {
      violations.push("vault-path-invalid");
    }
  }
  if (chunk.mutations.some((mutation) => !isUtf8SortedUnique(mutation.parents))) {
    violations.push("parents-not-canonical");
  }
  return [...new Set(violations)];
}

function isValidCreatedAt(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  const numericYear = Number(year);
  const numericMonth = Number(month);
  const numericDay = Number(day);
  const numericHour = Number(hour);
  const numericMinute = Number(minute);
  const numericSecond = Number(second);
  if (
    numericYear < 1 ||
    numericMonth < 1 ||
    numericMonth > 12 ||
    numericHour > 23 ||
    numericMinute > 59 ||
    numericSecond > 59
  ) {
    return false;
  }
  const leapYear = numericYear % 4 === 0 && (numericYear % 100 !== 0 || numericYear % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    numericMonth - 1
  ];
  return numericDay >= 1 && numericDay <= daysInMonth;
}

function isValidClientVersion(value: string): boolean {
  return /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    value,
  );
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
      parent?.items.some((item) => item.path === deleted.path),
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
  if (tree.profile.baseFiles.some((baseFile) => !isValidBaseFile(baseFile))) {
    violations.push("base-file-invalid");
  }
  if (
    tree.profile.minimumTargetAppVersion !== undefined &&
    !isValidPlainSemVer(tree.profile.minimumTargetAppVersion)
  ) {
    violations.push("minimum-app-version-invalid");
  }
  if (
    [
      ...tree.profile.portablePluginIds,
      ...tree.profile.pluginPackages,
      ...tree.profile.pluginData,
      ...tree.enabledCommunityPlugins,
    ].some((pluginId) => validatePluginId(pluginId).length > 0)
  ) {
    violations.push("plugin-id-invalid");
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
  if (tree.items.some((item) => validateProtocolPath(item.path).length > 0)) {
    violations.push("config-item-path-invalid");
  }
  const putPaths = tree.items.filter((item) => item.kind === "put").map((item) => item.path);
  if (!isCaseFoldUnique(putPaths)) violations.push("config-put-case-alias");
  if (hasPathPrefixConflict(putPaths)) violations.push("config-put-path-prefix-conflict");
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

function isValidBaseFile(baseFile: string): boolean {
  if (validateProtocolPath(baseFile).length > 0 || baseFile.includes("/")) return false;
  const folded = defaultCaseFold151(baseFile);
  if (
    [
      "community-plugins.json",
      "core-plugins.json",
      "plugins",
      "themes",
      "snippets",
      ".obsidian-s3-sync-local",
    ].includes(folded)
  ) {
    return false;
  }
  return !(folded.startsWith("workspace") && folded.endsWith(".json"));
}

function isValidPlainSemVer(value: string): boolean {
  return /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value);
}

function hasPathPrefixConflict(paths: string[]): boolean {
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      if (paths[left].startsWith(`${paths[right]}/`) || paths[right].startsWith(`${paths[left]}/`)) {
        return true;
      }
    }
  }
  return false;
}

export function validateProtocolPath(path: string): PathViolation[] {
  const violations: PathViolation[] = [];
  if (normalizeNfc151(path) !== path) violations.push("path-not-nfc");
  if (utf8ByteLength(path) > 1024) violations.push("path-too-long");
  if (
    path.length === 0 ||
    /^[\/]|[\\]|\/\/|\/$/.test(path) ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    violations.push("path-invalid-segment");
  }
  if (/[\u0000-\u001f\u007f]/.test(path)) violations.push("path-control-character");
  return violations;
}

export function validatePluginId(pluginId: string): PluginIdViolation[] {
  const violations: PluginIdViolation[] = [];
  if (normalizeNfc151(pluginId) !== pluginId) violations.push("plugin-id-not-nfc");
  if (utf8ByteLength(pluginId) === 0 || utf8ByteLength(pluginId) > 255) {
    violations.push("plugin-id-too-long");
  }
  if (
    pluginId === "." ||
    pluginId === ".." ||
    /[<>:"/\\|?*]/.test(pluginId) ||
    /[. ]$/.test(pluginId)
  ) {
    violations.push("plugin-id-invalid-shape");
  }
  if (/[\u0000-\u001f\u007f]/.test(pluginId)) violations.push("plugin-id-control-character");
  const stem = pluginId.split(".", 1)[0].replace(/[a-z]/g, (character) => character.toUpperCase());
  if (
    ["CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$"].includes(stem) ||
    /^(COM|LPT)[1-9¹²³]$/.test(stem)
  ) {
    violations.push("plugin-id-reserved-name");
  }
  return violations;
}

export function validateRepositoryDescriptor(
  descriptor: RepositoryDescriptorForSemantics,
): RepositoryDescriptorViolation[] {
  const violations: RepositoryDescriptorViolation[] = [];
  if (descriptor.configDir.length === 0 || validateProtocolPath(descriptor.configDir).length > 0) {
    violations.push("descriptor-config-dir-invalid");
  }
  if (!isUtf8SortedUnique(descriptor.historicalConfigDirs)) {
    violations.push("descriptor-historical-dirs-not-canonical");
  }
  const seen = new Set<string>([defaultCaseFold151(normalizeNfc151(descriptor.configDir))]);
  for (const historical of descriptor.historicalConfigDirs) {
    if (validateProtocolPath(historical).length > 0) violations.push("descriptor-historical-dir-invalid");
    const caseFoldKey = defaultCaseFold151(normalizeNfc151(historical));
    if (seen.has(caseFoldKey)) violations.push("descriptor-historical-dir-case-alias");
    seen.add(caseFoldKey);
  }
  return [...new Set(violations)];
}

export function validateConfigTreeExcludedPaths(
  currentConfigDir: string,
  historicalConfigDirs: string[],
  items: Array<{ path: string }>,
): ConfigTreeExcludedPathViolation[] {
  const historical = historicalConfigDirs.map((root) => defaultCaseFold151(normalizeNfc151(root)));
  const localExcluded = [".obsidian-s3-sync-local", "plugins/obsidian-s3-sync"].map((root) =>
    defaultCaseFold151(normalizeNfc151(root)),
  );
  const current = defaultCaseFold151(normalizeNfc151(currentConfigDir));
  for (const item of items) {
    const itemKey = defaultCaseFold151(normalizeNfc151(item.path));
    const vaultPath = current.length === 0 ? itemKey : `${current}/${itemKey}`;
    if (
      historical.some((root) => vaultPath === root || vaultPath.startsWith(`${root}/`)) ||
      localExcluded.some((root) => itemKey === root || itemKey.startsWith(`${root}/`))
    ) {
      return ["config-item-in-excluded-root"];
    }
  }
  return [];
}
