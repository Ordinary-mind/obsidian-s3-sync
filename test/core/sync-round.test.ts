import { describe, expect, it } from "vitest";
import { classifyCommitReceive } from "../../core/receive";
import { advanceSyncRound } from "../../core/sync-round";
import { canApplyConfigBatch } from "../../core/config-apply";
import { retryDelayMs } from "../../core/backoff";
import { hasOutstandingSafetyWork } from "../../core/status";

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
  it("makes retry delay bounded and exposes unresolved safety work", () => {
    expect(retryDelayMs(0)).toBe(1000);
    expect(retryDelayMs(20)).toBe(60000);
    expect(hasOutstandingSafetyWork({ phase: "idle", health: "healthy", pendingDependencies: 0, pendingApply: 1, outboxEntries: 0, conflicts: 0 })).toBe(true);
  });
});
