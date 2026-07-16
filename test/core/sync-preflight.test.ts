import { describe, expect, it } from "vitest";
import type { OperationalStatus, RecoveryBlocker } from "../../core/operational-status";
import {
  syncPreflightBlocker,
  verifiedRepositoryOperationalStatus,
  verifiedTerminalOutboxOperationalStatus,
} from "../../core/sync-preflight";

const healthy: OperationalStatus = {
  phase: "idle",
  pendingApply: 0,
  outbox: 0,
  localConcurrentRecords: 0,
  recoveryFiles: 0,
  postCaptureEdits: 0,
  commitGaps: 0,
  conflicts: 0,
  retryAttempt: 0,
  decisions: [],
  audit: { state: "never", completedObjects: 0, totalObjects: 0, missingClosure: [], resumable: false },
  recoveryBlockers: [],
  repositoryIdentityValid: true,
};

const report = "{\"type\":\"s3-sync-operation-error\",\"schemaVersion\":3}";

function blocker(value: RecoveryBlocker): OperationalStatus {
  return { ...healthy, phase: "read-only", recoveryBlockers: [value] };
}

describe("sync preflight", () => {
  it("allows repository identity to be revalidated without creating a sticky recovery lock", () => {
    const stale: OperationalStatus = {
      ...healthy,
      phase: "read-only",
      repositoryIdentityValid: false,
      retryAttempt: 3,
      retryAt: 1234,
      lastError: {
        category: "repository-identity",
        message: "仓库身份待重验",
        report,
        syncStage: "repository-verification",
      },
    };

    expect(syncPreflightBlocker({ status: stale })).toBeUndefined();
    expect(verifiedRepositoryOperationalStatus(stale)).toMatchObject({
      phase: "idle",
      repositoryIdentityValid: true,
      retryAttempt: 0,
      retryAt: undefined,
      lastError: undefined,
    });
  });

  it("blocks only concrete manual recovery artifacts", () => {
    expect(syncPreflightBlocker({ status: blocker({
      code: "repository-state",
      source: "repository-state",
      disposition: "manual",
      message: "state unavailable",
    }) })).toBe("repository-state-recovery");
    expect(syncPreflightBlocker({ status: blocker({
      code: "vault-apply",
      source: "vault-apply-journal",
      disposition: "manual",
      message: "vault apply",
    }) })).toBe("apply-journal-recovery");
    expect(syncPreflightBlocker({ status: blocker({
      code: "config-apply",
      source: "config-apply-journal",
      disposition: "manual",
      message: "config apply",
    }) })).toBe("config-journal-recovery");
    expect(syncPreflightBlocker({ status: { ...healthy, phase: "stopped" } })).toBe("repository-stopped");
  });

  it("allows terminal Outbox recovery and clears only its typed error after proof", () => {
    const terminal: OperationalStatus = {
      ...healthy,
      phase: "recovering",
      recoveryBlockers: [{
        code: "durable-outbox",
        source: "outbox",
        disposition: "automatic",
        message: "automatic replay",
      }],
      lastError: {
        category: "integrity",
        message: "Outbox replay failed",
        report,
        syncStage: "outbox-replay",
      },
    };
    expect(syncPreflightBlocker({ status: terminal })).toBeUndefined();
    expect(verifiedTerminalOutboxOperationalStatus(terminal)).toMatchObject({
      phase: "idle",
      lastError: undefined,
    });

    const unrelated: OperationalStatus = {
      ...terminal,
      lastError: {
        category: "integrity",
        message: "完整校验缺失闭包",
        report,
        syncStage: "remote-list",
      },
    };
    expect(verifiedTerminalOutboxOperationalStatus(unrelated)).toBe(unrelated);
  });
});
