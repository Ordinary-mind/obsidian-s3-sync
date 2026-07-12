import { describe, expect, it } from "vitest";
import { adoptProjection, mayAdvanceProjection } from "../../core/projection";
describe("projection accounting", () => { it("requires matching generation and after-image before advancing", () => {
  const state = adoptProjection({ projectedHeads: [], projectedValueHash: undefined, generation: 0 }, ["b", "a"], "value");
  expect(state).toEqual({ projectedHeads: ["a", "b"], projectedValueHash: "value", generation: 1 });
  expect(mayAdvanceProjection(state, 1, "target", "target")).toBe(true);
  expect(mayAdvanceProjection(state, 2, "target", "target")).toBe(false);
}); });
