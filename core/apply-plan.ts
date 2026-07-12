export interface ApplyPrecondition {
  targetHeads: string[];
  observedHeads: string[];
  projectedValueHash: string | undefined;
  localValueHash: string | undefined;
  hasDirtyIntent: boolean;
}

export type ApplyDecision = "adopt-without-write" | "apply" | "freeze-local-change" | "stale-plan";

export function decideApply(precondition: ApplyPrecondition, targetValueHash: string | undefined): ApplyDecision {
  if (!sameSet(precondition.targetHeads, precondition.observedHeads)) return "stale-plan";
  if (precondition.hasDirtyIntent || precondition.localValueHash !== precondition.projectedValueHash) return "freeze-local-change";
  if (precondition.localValueHash === targetValueHash) return "adopt-without-write";
  return "apply";
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === new Set(right).size && left.every((value) => right.includes(value));
}
