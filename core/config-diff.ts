import type { ConfigProfile } from "./types";
import type { ManagedConfigItem } from "./config-snapshot-builder";

export type ConfigDiffKind = "add" | "modify" | "delete" | "stop-managing" | "unchanged";

export interface ConfigDiffEntry {
  path: string;
  kind: ConfigDiffKind;
  codeChange: boolean;
  sensitive: boolean;
  before?: ManagedConfigItem;
  after?: ManagedConfigItem;
}

export function diffManagedConfigItems(beforeItems: readonly ManagedConfigItem[], afterItems: readonly ManagedConfigItem[]): ConfigDiffEntry[] {
  const before = new Map(beforeItems.map((item) => [item.path, item]));
  const after = new Map(afterItems.map((item) => [item.path, item]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths.map((path) => {
    const left = before.get(path); const right = after.get(path);
    let kind: ConfigDiffKind;
    if (!left) kind = right?.kind === "delete" ? "delete" : "add";
    else if (!right) kind = "stop-managing";
    else if (right.kind === "delete" && left.kind !== "delete") kind = "delete";
    else if (sameItem(left, right)) kind = "unchanged";
    else kind = "modify";
    return {
      path,
      kind,
      codeChange: /^plugins\/[^/]+\/.+\.(?:js|css)$/i.test(path),
      sensitive: /^plugins\/[^/]+\/data\.json$/.test(path),
      ...(left ? { before: { ...left } } : {}),
      ...(right ? { after: { ...right } } : {}),
    };
  });
}

export function buildMergedConfigItems(input: {
  left: readonly ManagedConfigItem[];
  right: readonly ManagedConfigItem[];
  selections: Readonly<Record<string, "left" | "right" | "stop-managing">>;
}): ManagedConfigItem[] {
  const left = new Map(input.left.map((item) => [item.path, item]));
  const right = new Map(input.right.map((item) => [item.path, item]));
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  const result: ManagedConfigItem[] = [];
  for (const path of paths) {
    const selection = input.selections[path];
    if (!selection) throw new Error(`config merge needs an explicit selection for ${path}`);
    if (selection === "stop-managing") continue;
    const selected = selection === "left" ? left.get(path) : right.get(path);
    if (!selected) throw new Error(`selected config merge side has no item for ${path}`);
    result.push({ ...selected });
  }
  return result;
}

export interface ConfigMergePublication {
  profile: ConfigProfile;
  enabledCommunityPlugins: string[];
  items: ManagedConfigItem[];
  parents: string[];
}

export function freezeConfigMergePublication(input: Omit<ConfigMergePublication, "parents"> & { observedHeads: readonly string[] }): ConfigMergePublication {
  if (input.observedHeads.length === 0) throw new Error("ConfigTree conflict merge requires observed heads");
  return {
    profile: structuredClone(input.profile),
    enabledCommunityPlugins: [...input.enabledCommunityPlugins],
    items: input.items.map((item) => ({ ...item })),
    parents: [...new Set(input.observedHeads)].sort(),
  };
}

function sameItem(left: ManagedConfigItem, right: ManagedConfigItem): boolean {
  return left.kind === right.kind && (left.kind === "delete" || right.kind === "delete"
    ? left.kind === right.kind
    : left.hash === right.hash && left.size === right.size);
}
