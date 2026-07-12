import { describe, expect, it } from "vitest";
import { decideApply } from "../../core/apply-plan";

describe("safe apply decisions", () => {
  const base = { targetHeads: ["remote"], observedHeads: ["remote"], projectedValueHash: "before", localValueHash: "before", hasDirtyIntent: false };
  it("does not overwrite local divergence or stale remote plans", () => {
    expect(decideApply(base, "before")).toBe("adopt-without-write");
    expect(decideApply(base, "after")).toBe("apply");
    expect(decideApply({ ...base, localValueHash: "local" }, "after")).toBe("freeze-local-change");
    expect(decideApply({ ...base, hasDirtyIntent: true }, "after")).toBe("freeze-local-change");
    expect(decideApply({ ...base, observedHeads: ["remote", "later"] }, "after")).toBe("stale-plan");
  });
});
