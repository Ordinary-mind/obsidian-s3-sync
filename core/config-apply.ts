export interface ConfigApplyPrecondition {
  projectedTreeHash: string | undefined;
  currentTreeHash: string | undefined;
  targetHeads: string[];
  observedHeads: string[];
  repositoryLocatorMatches?: boolean;
}

export function canApplyConfigBatch(precondition: ConfigApplyPrecondition): boolean {
  return precondition.repositoryLocatorMatches !== false
    && precondition.projectedTreeHash === precondition.currentTreeHash
    && sameSet(precondition.targetHeads, precondition.observedHeads);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && new Set(left).size === new Set(right).size && left.every((value) => right.includes(value)); }
