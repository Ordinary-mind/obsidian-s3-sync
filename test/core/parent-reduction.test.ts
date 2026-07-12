import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { planParentReduction } from "../../core/parent-reduction";

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
});
