export interface ParentReductionStep {
  parents: string[];
  outputVersionId: string;
}

export function planParentReduction(frozenHeads: readonly string[], createOutputVersionId: (step: number) => string, maxParents = 1024): ParentReductionStep[] {
  if (maxParents < 2) throw new Error("parent reduction requires at least two parents per step");
  let current = [...new Set(frozenHeads)].sort();
  const steps: ParentReductionStep[] = [];
  while (current.length > maxParents) {
    const parents = current.slice(0, maxParents);
    const outputVersionId = createOutputVersionId(steps.length);
    steps.push({ parents, outputVersionId });
    current = [outputVersionId, ...current.slice(maxParents)].sort();
  }
  if (steps.length > 0) steps.push({ parents: current, outputVersionId: createOutputVersionId(steps.length) });
  return steps;
}
