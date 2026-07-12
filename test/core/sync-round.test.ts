import { describe, expect, it } from "vitest";
import { classifyCommitReceive } from "../../core/receive";
import { advanceSyncRound } from "../../core/sync-round";
import { canApplyConfigBatch } from "../../core/config-apply";

describe("sync round coordination primitives", () => {
  it("only advances through safe round phases", () => {
    expect(advanceSyncRound("idle", "recovering")).toBe("recovering");
    expect(() => advanceSyncRound("idle", "publishing")).toThrow("invalid sync");
  });
  it("keeps valid late dependencies pending while isolating invalid envelopes", () => {
    expect(classifyCommitReceive({ envelopeValid: true, dependenciesPresent: false, dependenciesValid: true })).toBe("pending-dependency");
    expect(classifyCommitReceive({ envelopeValid: false, dependenciesPresent: true, dependenciesValid: true })).toBe("isolated-integrity");
  });
  it("requires the full current ConfigTree and heads before batch apply", () => {
    expect(canApplyConfigBatch({ projectedTreeHash: "tree", currentTreeHash: "tree", targetHeads: ["h"], observedHeads: ["h"] })).toBe(true);
    expect(canApplyConfigBatch({ projectedTreeHash: "tree", currentTreeHash: "local-change", targetHeads: ["h"], observedHeads: ["h"] })).toBe(false);
  });
});
