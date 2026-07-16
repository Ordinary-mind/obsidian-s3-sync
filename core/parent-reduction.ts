import { parseVersionId } from "./version-id";
import { compareUtf8 } from "../protocol/utf8";

export interface ParentReductionStep {
  parents: string[];
  outputVersionId: string;
}

export type ParentReductionValue =
  | { kind: "put"; hash: string; size: number }
  | { kind: "delete" };

export interface ParentReductionHead {
  versionId: string;
  value: ParentReductionValue;
}

export interface SafeParentReductionPlan {
  mode: "automatic-equivalent" | "confirmed-conflict";
  frozenHeads: string[];
  selectedValue: ParentReductionValue;
  steps: ParentReductionStep[];
  finalParents: string[];
}

export type SafeParentReductionAssessment =
  | { status: "confirmation-required"; frozenHeads: string[]; semanticValues: ParentReductionValue[] }
  | { status: "ready"; plan: SafeParentReductionPlan };

export interface ParentReductionProgress {
  completedSteps: number;
  currentHeads: string[];
  nextStep?: ParentReductionStep;
  readyForFinalResolution: boolean;
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

export function planSafeParentReduction(input: {
  heads: readonly ParentReductionHead[];
  selectedValue?: ParentReductionValue;
  conflictSelectionConfirmed?: boolean;
  createOutputVersionId: (step: number) => string;
  maxParents?: number;
}): SafeParentReductionAssessment {
  const maxParents = input.maxParents ?? 1024;
  assertMaxParents(maxParents);
  const byVersion = new Map<string, ParentReductionValue>();
  for (const head of input.heads) {
    parseVersionId(head.versionId);
    const existing = byVersion.get(head.versionId);
    if (existing && semanticKey(existing) !== semanticKey(head.value)) throw new Error("parent reduction head has inconsistent values");
    byVersion.set(head.versionId, copyValue(head.value));
  }
  const frozenHeads = [...byVersion.keys()].sort();
  if (frozenHeads.length === 0) throw new Error("parent reduction requires frozen heads");
  const semanticValues = [...new Map([...byVersion.values()].map((value) => [semanticKey(value), copyValue(value)])).values()]
    .sort((left, right) => compareUtf8(semanticKey(left), semanticKey(right)));
  if (semanticValues.length > 1 && (!input.selectedValue || input.conflictSelectionConfirmed !== true)) {
    return { status: "confirmation-required", frozenHeads, semanticValues };
  }
  const mode = semanticValues.length === 1 ? "automatic-equivalent" : "confirmed-conflict";
  const selectedValue = mode === "automatic-equivalent" ? semanticValues[0] : copyValue(input.selectedValue!);
  validateValue(selectedValue);
  const reduction = buildReductionSteps(frozenHeads, input.createOutputVersionId, maxParents);
  return {
    status: "ready",
    plan: {
      mode,
      frozenHeads,
      selectedValue,
      steps: reduction.steps,
      finalParents: reduction.finalParents,
    },
  };
}

export function resumeParentReduction(
  plan: SafeParentReductionPlan,
  publishedOutputVersionIds: ReadonlySet<string>,
): ParentReductionProgress {
  let current = [...plan.frozenHeads];
  let completedSteps = 0;
  let gap = false;
  for (const step of plan.steps) {
    const published = publishedOutputVersionIds.has(step.outputVersionId);
    if (!published) {
      gap = true;
      continue;
    }
    if (gap) throw new Error("parent reduction publication is not a contiguous prefix");
    if (step.parents.some((parent) => !current.includes(parent))) throw new Error("parent reduction step no longer covers current heads");
    const covered = new Set(step.parents);
    current = [step.outputVersionId, ...current.filter((head) => !covered.has(head))].sort();
    completedSteps += 1;
  }
  const expected = completedSteps === plan.steps.length ? plan.finalParents : plan.steps[completedSteps]?.parents;
  if (expected && completedSteps === plan.steps.length
    && (expected.length !== current.length || expected.some((head, index) => head !== current[index]))) {
    throw new Error("parent reduction final parents changed");
  }
  return {
    completedSteps,
    currentHeads: current,
    ...(completedSteps < plan.steps.length ? { nextStep: copyStep(plan.steps[completedSteps]) } : {}),
    readyForFinalResolution: completedSteps === plan.steps.length,
  };
}

export function isParentReductionFinalCurrent(plan: SafeParentReductionPlan, observedHeads: readonly string[]): boolean {
  const current = [...new Set(observedHeads)].sort();
  return current.length === plan.finalParents.length && current.every((head, index) => head === plan.finalParents[index]);
}

function buildReductionSteps(
  frozenHeads: readonly string[],
  createOutputVersionId: (step: number) => string,
  maxParents: number,
): { steps: ParentReductionStep[]; finalParents: string[] } {
  let current = [...new Set(frozenHeads)].sort();
  const steps: ParentReductionStep[] = [];
  const outputs = new Set<string>();
  while (current.length > maxParents) {
    const parents = current.slice(0, maxParents);
    const outputVersionId = createOutputVersionId(steps.length);
    parseVersionId(outputVersionId);
    if (current.includes(outputVersionId) || outputs.has(outputVersionId)) throw new Error("parent reduction output Version ID is not unique");
    outputs.add(outputVersionId);
    steps.push({ parents, outputVersionId });
    current = [outputVersionId, ...current.slice(maxParents)].sort();
  }
  return { steps, finalParents: current };
}

function assertMaxParents(maxParents: number): void {
  if (!Number.isSafeInteger(maxParents) || maxParents < 2 || maxParents > 1024) {
    throw new Error("parent reduction requires between 2 and 1,024 parents per step");
  }
}

function semanticKey(value: ParentReductionValue): string {
  return value.kind === "delete" ? "delete" : `put:${value.hash}:${value.size}`;
}

function validateValue(value: ParentReductionValue): void {
  if (value.kind === "put" && (!/^[0-9a-f]{64}$/.test(value.hash) || !Number.isSafeInteger(value.size) || value.size < 0)) {
    throw new Error("parent reduction selected value is invalid");
  }
}

function copyValue(value: ParentReductionValue): ParentReductionValue {
  validateValue(value);
  return value.kind === "delete" ? { kind: "delete" } : { kind: "put", hash: value.hash, size: value.size };
}

function copyStep(step: ParentReductionStep): ParentReductionStep {
  return { parents: [...step.parents], outputVersionId: step.outputVersionId };
}
