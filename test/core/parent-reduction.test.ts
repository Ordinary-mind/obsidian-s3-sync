import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  isParentReductionFinalCurrent,
  planParentReduction,
  planSafeParentReduction,
  resumeParentReduction,
} from "../../core/parent-reduction";

describe("parent reduction planning", () => {
  it("reduces 1,025 frozen heads without absorbing later observations", () => {
    const heads = Array.from({ length: 1025 }, (_, index) => index.toString().padStart(4, "0"));
    const plan = planParentReduction(heads, (step) => `reduced:${step}`);
    expect(plan).toHaveLength(2);
    expect(plan[0].parents).toHaveLength(1024);
    expect(plan[1].parents).toEqual(["1024", "reduced:0"]);
  });
  it("does not create a reduction for 1,024 or fewer heads", () => {
    expect(planParentReduction(["a", "b"], () => "unused")).toEqual([]);
  });
  it("keeps every frozen head reachable through any generated reduction chain", () => {
    fc.assert(fc.property(fc.integer({ min: 1025, max: 4096 }), (count) => {
      const heads = Array.from({ length: count }, (_, index) => index.toString().padStart(5, "0"));
      const plan = planParentReduction(heads, (step) => `r:${step}`);
      expect(plan.every((step) => step.parents.length >= 2 && step.parents.length <= 1024)).toBe(true);
      expect(plan.at(-1)?.parents.length).toBeLessThanOrEqual(1024);
    }), { numRuns: 100, seed: 20260712 });
  });

  it("automatically reduces only equivalent heads and requires a confirmed value for conflicts", () => {
    const version = (index: number) => `${index.toString(16).padStart(64, "0")}:0:0`;
    const equivalent = planSafeParentReduction({
      heads: Array.from({ length: 1025 }, (_, index) => ({
        versionId: version(index),
        value: { kind: "put" as const, hash: "a".repeat(64), size: 1 },
      })),
      createOutputVersionId: (step) => version(10_000 + step),
    });
    expect(equivalent.status).toBe("ready");
    if (equivalent.status !== "ready") throw new Error("expected ready reduction");
    expect(equivalent.plan).toMatchObject({ mode: "automatic-equivalent", steps: [expect.objectContaining({ parents: expect.any(Array) })] });
    expect(equivalent.plan.steps[0].parents).toHaveLength(1024);
    expect(equivalent.plan.finalParents).toHaveLength(2);

    const conflictHeads = Array.from({ length: 1025 }, (_, index) => ({
      versionId: version(index),
      value: { kind: "put" as const, hash: (index % 2 ? "b" : "a").repeat(64), size: 1 },
    }));
    expect(planSafeParentReduction({
      heads: conflictHeads,
      createOutputVersionId: (step) => version(20_000 + step),
    })).toMatchObject({ status: "confirmation-required", semanticValues: expect.any(Array) });
    expect(planSafeParentReduction({
      heads: conflictHeads,
      selectedValue: { kind: "put", hash: "c".repeat(64), size: 2 },
      conflictSelectionConfirmed: true,
      createOutputVersionId: (step) => version(20_000 + step),
    })).toMatchObject({ status: "ready", plan: { mode: "confirmed-conflict" } });
  });

  it("resumes after every reduction crash boundary without absorbing later heads", () => {
    const version = (index: number) => `${index.toString(16).padStart(64, "0")}:0:0`;
    const assessment = planSafeParentReduction({
      heads: Array.from({ length: 2050 }, (_, index) => ({
        versionId: version(index),
        value: { kind: "delete" as const },
      })),
      createOutputVersionId: (step) => version(30_000 + step),
    });
    if (assessment.status !== "ready") throw new Error("expected ready reduction");
    const plan = assessment.plan;
    for (let completed = 0; completed <= plan.steps.length; completed += 1) {
      const published = new Set(plan.steps.slice(0, completed).map((step) => step.outputVersionId));
      const progress = resumeParentReduction(plan, published);
      expect(progress.completedSteps).toBe(completed);
      expect(new Set(progress.currentHeads).size).toBe(progress.currentHeads.length);
      expect(reachableLeaves(progress.currentHeads, plan.steps.slice(0, completed))).toEqual(new Set(plan.frozenHeads));
      expect(progress.readyForFinalResolution).toBe(completed === plan.steps.length);
    }
    const complete = resumeParentReduction(plan, new Set(plan.steps.map((step) => step.outputVersionId)));
    expect(isParentReductionFinalCurrent(plan, complete.currentHeads)).toBe(true);
    expect(isParentReductionFinalCurrent(plan, [...complete.currentHeads, version(40_000)])).toBe(false);
  });
});

function reachableLeaves(
  currentHeads: readonly string[],
  completedSteps: readonly { parents: string[]; outputVersionId: string }[],
): Set<string> {
  const parentsByOutput = new Map(completedSteps.map((step) => [step.outputVersionId, step.parents]));
  const pending = [...currentHeads];
  const visited = new Set<string>();
  const leaves = new Set<string>();
  while (pending.length > 0) {
    const head = pending.pop()!;
    if (visited.has(head)) continue;
    visited.add(head);
    const parents = parentsByOutput.get(head);
    if (parents) pending.push(...parents);
    else leaves.add(head);
  }
  return leaves;
}
