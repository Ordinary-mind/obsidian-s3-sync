import { describe, expect, it } from "vitest";
import { destructiveRepositoryResetAvailable, mayClaimRepositoryFullyHealthy, repositoryHealthLabel, retryCountdownSeconds, type OperationalStatus } from "../../core/operational-status";

const healthy: OperationalStatus = {
  phase: "idle", pendingApply: 0, outbox: 0, localConcurrentRecords: 0, recoveryFiles: 0, postCaptureEdits: 0,
  commitGaps: 0, conflicts: 0, retryAttempt: 0, decisions: [], recoveryRequired: false, repositoryIdentityValid: true,
  audit: { state: "complete", completedObjects: 10, totalObjects: 10, missingClosure: [], resumable: false },
};

describe("operational status", () => {
  it("claims full health only after a complete closure audit", () => {
    expect(repositoryHealthLabel(healthy)).toBe("healthy");
    expect(mayClaimRepositoryFullyHealthy(healthy)).toBe(true);
    expect(mayClaimRepositoryFullyHealthy({ ...healthy, audit: { ...healthy.audit, state: "cancelled", resumable: true } })).toBe(false);
    expect(repositoryHealthLabel({ ...healthy, recoveryRequired: true })).toBe("diagnostics-only");
  });

  it("shows retry countdown and never exposes a destructive reset", () => {
    expect(retryCountdownSeconds({ ...healthy, retryAt: 10_500 }, 8_001)).toBe(3);
    expect(destructiveRepositoryResetAvailable()).toBe(false);
  });
});
