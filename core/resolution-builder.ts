import type { ConflictResolutionIntent } from "./resolution";

export interface ResolutionMutationPlan {
  path: string;
  parents: string[];
  kind: "put" | "delete";
  valueHash?: string;
  size?: number;
  stagedRef?: string;
}

export interface ResolutionSelectedContentObservation {
  hash: string;
  size: number;
  stagedRef: string;
}

export function buildResolutionMutation(
  intent: ConflictResolutionIntent,
  currentHeads: readonly string[],
  selectedContent?: ResolutionSelectedContentObservation,
): ResolutionMutationPlan {
  const canonical = [...new Set(currentHeads)].sort();
  if (canonical.length !== intent.parents.length || canonical.some((head, index) => head !== intent.parents[index])) throw new Error("conflict set changed; refresh resolution intent");
  if (intent.selectionKind === "local" || intent.selectionKind === "merged") {
    if (intent.selectedValue.kind !== "put" || !selectedContent
      || selectedContent.hash !== intent.selectedValue.hash
      || selectedContent.size !== intent.selectedValue.size
      || selectedContent.stagedRef !== intent.selectedValue.stagedRef) {
      throw new Error("selected conflict content changed; refresh resolution intent");
    }
  }
  return intent.selectedValue.kind === "put"
    ? {
      path: intent.path,
      parents: [...intent.parents],
      kind: "put",
      valueHash: intent.selectedValue.hash,
      ...(intent.selectedValue.size !== undefined ? { size: intent.selectedValue.size } : {}),
      ...(intent.selectedValue.stagedRef ? { stagedRef: intent.selectedValue.stagedRef } : {}),
    }
    : { path: intent.path, parents: [...intent.parents], kind: "delete" };
}
