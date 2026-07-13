export interface ConflictResolutionIntent {
  path: string;
  parents: string[];
  selectedValue: { kind: "put"; hash: string; stagedRef?: string } | { kind: "delete" };
  selectedValueHash?: string;
}

export function captureConflictResolution(
  path: string,
  observedHeads: readonly string[],
  selected: string | { kind: "put"; hash: string; stagedRef?: string } | { kind: "delete" },
): ConflictResolutionIntent {
  const parents = [...new Set(observedHeads)].sort();
  if (parents.length === 0) throw new Error("conflict resolution requires at least one observed head");
  const selectedValue = typeof selected === "string" ? { kind: "put" as const, hash: selected } : { ...selected };
  return Object.freeze({
    path,
    parents,
    selectedValue,
    ...(selectedValue.kind === "put" ? { selectedValueHash: selectedValue.hash } : {}),
  });
}

export function isResolutionCurrent(intent: ConflictResolutionIntent, observedHeads: readonly string[]): boolean {
  const current = [...new Set(observedHeads)].sort();
  return current.length === intent.parents.length && current.every((head, index) => head === intent.parents[index]);
}
