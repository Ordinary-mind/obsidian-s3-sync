export interface ConflictResolutionIntent {
  path: string;
  parents: string[];
  selectedValueHash: string;
}

export function captureConflictResolution(path: string, observedHeads: readonly string[], selectedValueHash: string): ConflictResolutionIntent {
  const parents = [...new Set(observedHeads)].sort();
  if (parents.length === 0) throw new Error("conflict resolution requires at least one observed head");
  return Object.freeze({ path, parents, selectedValueHash });
}

export function isResolutionCurrent(intent: ConflictResolutionIntent, observedHeads: readonly string[]): boolean {
  const current = [...new Set(observedHeads)].sort();
  return current.length === intent.parents.length && current.every((head, index) => head === intent.parents[index]);
}
