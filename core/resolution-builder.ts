import type { ConflictResolutionIntent } from "./resolution";

export interface ResolutionMutationPlan {
  path: string;
  parents: string[];
  valueHash: string;
}

export function buildResolutionMutation(intent: ConflictResolutionIntent, currentHeads: readonly string[]): ResolutionMutationPlan {
  const canonical = [...new Set(currentHeads)].sort();
  if (canonical.length !== intent.parents.length || canonical.some((head, index) => head !== intent.parents[index])) throw new Error("conflict set changed; refresh resolution intent");
  return { path: intent.path, parents: [...intent.parents], valueHash: intent.selectedValueHash };
}
