import type { ConflictResolutionIntent } from "./resolution";

export interface ResolutionMutationPlan {
  path: string;
  parents: string[];
  kind: "put" | "delete";
  valueHash?: string;
  stagedRef?: string;
}

export function buildResolutionMutation(intent: ConflictResolutionIntent, currentHeads: readonly string[]): ResolutionMutationPlan {
  const canonical = [...new Set(currentHeads)].sort();
  if (canonical.length !== intent.parents.length || canonical.some((head, index) => head !== intent.parents[index])) throw new Error("conflict set changed; refresh resolution intent");
  return intent.selectedValue.kind === "put"
    ? { path: intent.path, parents: [...intent.parents], kind: "put", valueHash: intent.selectedValue.hash, ...(intent.selectedValue.stagedRef ? { stagedRef: intent.selectedValue.stagedRef } : {}) }
    : { path: intent.path, parents: [...intent.parents], kind: "delete" };
}
