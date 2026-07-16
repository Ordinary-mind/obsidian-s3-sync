import type { ConfigProfile } from "./types";
import type { ManagedConfigItem } from "./config-snapshot-builder";
import { planSafeParentReduction, type ParentReductionStep } from "./parent-reduction";
import { compareUtf8 } from "../protocol/utf8";

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
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort(compareUtf8);
  return paths.map((path) => {
    const left = before.get(path); const right = after.get(path);
    let kind: ConfigDiffKind;
    if (!left) kind = right?.kind === "delete" ? "delete" : "add";
    else if (!right) kind = "stop-managing";
    else if (right.kind === "delete" && left.kind !== "delete") kind = "delete";
    else if (sameItem(left, right)) kind = "unchanged";
    else kind = "modify";
    const changesManagedBytes = kind !== "unchanged" && kind !== "stop-managing";
    return {
      path,
      kind,
      codeChange: changesManagedBytes && /^plugins\/[^/]+\/.+\.(?:js|css)$/i.test(path),
      sensitive: changesManagedBytes && /^plugins\/[^/]+\/data\.json$/.test(path),
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
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort(compareUtf8);
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
  const parents = [...new Set(input.observedHeads)].sort(compareUtf8);
  if (parents.length > 1024) throw new Error("ConfigTree conflict merge requires parent reduction");
  return {
    profile: structuredClone(input.profile),
    enabledCommunityPlugins: [...input.enabledCommunityPlugins],
    items: input.items.map((item) => ({ ...item })),
    parents,
  };
}

export type ConfigParentReductionAssessment =
  | { status: "confirmation-required"; frozenHeads: string[]; treeHashes: string[] }
  | { status: "ready"; frozenHeads: string[]; selectedTreeHash: string; steps: ParentReductionStep[]; finalParents: string[] };

export function planConfigParentReduction(input: {
  heads: readonly { versionId: string; treeHash: string }[];
  selectedTreeHash?: string;
  conflictSelectionConfirmed?: boolean;
  createOutputVersionId: (step: number) => string;
}): ConfigParentReductionAssessment {
  const assessment = planSafeParentReduction({
    heads: input.heads.map((head) => ({ versionId: head.versionId, value: { kind: "put" as const, hash: head.treeHash, size: 0 } })),
    ...(input.selectedTreeHash ? { selectedValue: { kind: "put" as const, hash: input.selectedTreeHash, size: 0 } } : {}),
    conflictSelectionConfirmed: input.conflictSelectionConfirmed,
    createOutputVersionId: input.createOutputVersionId,
  });
  if (assessment.status === "confirmation-required") {
    return {
      status: "confirmation-required",
      frozenHeads: assessment.frozenHeads,
      treeHashes: assessment.semanticValues.map((value) => value.kind === "put" ? value.hash : "").sort(compareUtf8),
    };
  }
  if (assessment.plan.selectedValue.kind !== "put") throw new Error("Config parent reduction selected a non-Tree value");
  return {
    status: "ready",
    frozenHeads: assessment.plan.frozenHeads,
    selectedTreeHash: assessment.plan.selectedValue.hash,
    steps: assessment.plan.steps,
    finalParents: assessment.plan.finalParents,
  };
}

function sameItem(left: ManagedConfigItem, right: ManagedConfigItem): boolean {
  return left.kind === right.kind && (left.kind === "delete" || right.kind === "delete"
    ? left.kind === right.kind
    : left.hash === right.hash && left.size === right.size);
}
