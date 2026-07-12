import { describe, expect, it } from "vitest";
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
});
