import { describe, expect, it } from "vitest";
import {
  auditCoveragePercent,
  derivePathDecision,
  destructiveRepositoryResetAvailable,
  diagnosticCategoryLabel,
  hasPendingSyncWork,
  mayClaimRepositoryFullyHealthy,
  mayRunMutatingSync,
  operationalPhaseLabel,
  operationalStatusBarText,
  pathDecisionLabel,
  pendingRecoveryVerificationCount,
  repositoryHealthDisplayLabel,
  repositoryHealthLabel,
  retryCountdownSeconds,
  summarizeRepositorySpace,
  type OperationalStatus,
} from "../../core/operational-status";

const healthy: OperationalStatus = {
  phase: "idle", pendingApply: 0, outbox: 0, localConcurrentRecords: 0, recoveryFiles: 0, postCaptureEdits: 0,
  commitGaps: 0, conflicts: 0, retryAttempt: 0, decisions: [], recoveryBlockers: [], repositoryIdentityValid: true,
  audit: { state: "complete", completedObjects: 10, totalObjects: 10, missingClosure: [], resumable: false },
};

describe("operational status", () => {
  it("claims full health only after a complete closure audit", () => {
    expect(repositoryHealthLabel(healthy)).toBe("healthy");
    expect(mayClaimRepositoryFullyHealthy(healthy)).toBe(true);
    expect(mayClaimRepositoryFullyHealthy({ ...healthy, audit: { ...healthy.audit, state: "cancelled", resumable: true } })).toBe(false);
    expect(repositoryHealthLabel({
      ...healthy,
      recoveryBlockers: [{
        code: "vault-apply",
        source: "vault-apply-journal",
        disposition: "manual",
        message: "manual recovery",
      }],
    })).toBe("diagnostics-only");
    expect(repositoryHealthLabel({ ...healthy, audit: { state: "never", completedObjects: 0, totalObjects: 0, missingClosure: [], resumable: false } })).toBe("attention");
    expect(repositoryHealthDisplayLabel({ ...healthy, audit: { state: "never", completedObjects: 0, totalObjects: 0, missingClosure: [], resumable: false } })).toBe("待完整校验");
    expect(auditCoveragePercent(healthy.audit)).toBe(100);
  });

  it("treats retained recovery copies as passive safety history rather than pending work", () => {
    const retained = { ...healthy, recoveryFiles: 1 };
    expect(repositoryHealthLabel(retained)).toBe("healthy");
    expect(hasPendingSyncWork(retained)).toBe(false);
    expect(pendingRecoveryVerificationCount(retained)).toBe(0);
    expect(hasPendingSyncWork({ ...retained, commitGaps: 1 })).toBe(true);
    expect(pendingRecoveryVerificationCount({ ...retained, commitGaps: 1 })).toBe(1);
  });

  it("shows retry countdown and never exposes a destructive reset", () => {
    expect(retryCountdownSeconds({ ...healthy, retryAt: 10_500 }, 8_001)).toBe(3);
    expect(destructiveRepositoryResetAvailable()).toBe(false);
    expect(mayRunMutatingSync(healthy)).toBe(true);
    expect(mayRunMutatingSync({
      ...healthy,
      recoveryBlockers: [{
        code: "durable-outbox",
        source: "outbox",
        disposition: "automatic",
        message: "automatic replay",
      }],
    })).toBe(true);
    expect(mayRunMutatingSync({ ...healthy, repositoryIdentityValid: false })).toBe(false);
    expect(operationalStatusBarText({ ...healthy, phase: "waiting-retry", retryAttempt: 2, retryAt: 20_000 })).toContain("等待重试 · 处理中 · 重试 2");
  });

  it("has stable labels for every operational phase, decision and error category", () => {
    expect([
      "idle", "recovering", "verifying-repository", "pulling", "merging", "applying", "scanning", "repulling",
      "freezing-outbox", "publishing", "verifying-publication", "auditing", "previewing", "waiting-retry", "read-only", "stopped",
    ].map((phase) => operationalPhaseLabel(phase as OperationalStatus["phase"]))).toEqual([
      "待命", "恢复", "验证仓库", "拉取", "归并", "应用", "扫描", "复查远端",
      "准备上传", "上传", "验证发布", "完整校验", "预览", "等待重试", "只读", "已停止",
    ]);
    expect(["same", "local-put", "remote-put", "tombstone", "conflict", "ignored", "unknown"].map((decision) => pathDecisionLabel(decision as never)))
      .toEqual(["相同", "本地上传", "远端写入", "删除", "冲突", "忽略", "未知"]);
    expect(diagnosticCategoryLabel("repository-identity")).toBe("仓库身份");
  });

  it("derives all frozen per-path preview decisions without silently choosing a side", () => {
    const base = { path: "note.md", ignored: false, localState: "present" as const, localHash: "local", localIntent: "none" as const };
    expect(derivePathDecision({ ...base, ignored: true, remote: { kind: "none" } }).decision).toBe("ignored");
    expect(derivePathDecision({ ...base, localHash: "same", remote: { kind: "put", hash: "same" } }).decision).toBe("same");
    expect(derivePathDecision({ ...base, remote: { kind: "none" } }).decision).toBe("local-put");
    expect(derivePathDecision({ ...base, localState: "absent", localHash: undefined, localIntent: "put", remote: { kind: "none" } }).decision).toBe("unknown");
    expect(derivePathDecision({ ...base, localState: "absent", localHash: undefined, remote: { kind: "put", hash: "remote" } }).decision).toBe("remote-put");
    expect(derivePathDecision({ ...base, localState: "absent", localHash: undefined, localIntent: "delete", remote: { kind: "none" } }).decision).toBe("tombstone");
    expect(derivePathDecision({ ...base, localState: "absent", localHash: undefined, remote: { kind: "delete" } }).decision).toBe("tombstone");
    expect(derivePathDecision({ ...base, localIntent: "put", remote: { kind: "put", hash: "remote" } }).decision).toBe("conflict");
    expect(derivePathDecision({ ...base, localIntent: "put", projectedHash: "remote", remote: { kind: "put", hash: "remote" } }).decision).toBe("local-put");
    expect(derivePathDecision({ ...base, localIntent: "delete", projectedHash: "remote", remote: { kind: "put", hash: "remote" } }).decision).toBe("tombstone");
    expect(derivePathDecision({ ...base, localIntent: "put", localHash: "remote", remote: { kind: "put", hash: "remote" } }).decision).toBe("same");
    expect(derivePathDecision({ ...base, remote: { kind: "conflict", reason: "two heads" } })).toMatchObject({ decision: "conflict", reason: "two heads" });
    expect(derivePathDecision({ ...base, remote: { kind: "unknown", reason: "pending parent" } })).toMatchObject({ decision: "unknown", reason: "pending parent" });
    expect(derivePathDecision({ ...base, localState: "unknown", remote: { kind: "none" } }).decision).toBe("unknown");
  });

  it("implements the Git-like empty, one-sided, equal and divergent path matrix", () => {
    const decide = (input: Parameters<typeof derivePathDecision>[0]) => derivePathDecision(input).decision;
    expect(decide({ path: "empty", ignored: false, localState: "absent", localIntent: "none", remote: { kind: "none" } })).toBe("same");
    expect(decide({ path: "local-only", ignored: false, localState: "present", localIntent: "none", remote: { kind: "none" } })).toBe("local-put");
    expect(decide({ path: "remote-only", ignored: false, localState: "absent", localIntent: "none", remote: { kind: "put", hash: "remote" } })).toBe("remote-put");
    expect(decide({ path: "equal", ignored: false, localState: "present", localHash: "same", localIntent: "none", remote: { kind: "put", hash: "same" } })).toBe("same");
    expect(decide({ path: "local-changed", ignored: false, localState: "present", localHash: "local", localIntent: "put", projectedHash: "base", remote: { kind: "put", hash: "base" } })).toBe("local-put");
    expect(decide({ path: "remote-changed", ignored: false, localState: "present", localHash: "base", localIntent: "none", projectedHash: "base", remote: { kind: "put", hash: "remote" } })).toBe("remote-put");
    expect(decide({ path: "both-changed", ignored: false, localState: "present", localHash: "local", localIntent: "put", projectedHash: "base", remote: { kind: "put", hash: "remote" } })).toBe("conflict");
    expect(decide({ path: "no-base", ignored: false, localState: "present", localHash: "local", localIntent: "put", remote: { kind: "put", hash: "remote" } })).toBe("conflict");
  });

  it("persists space totals without retaining individual orphan object keys", () => {
    const category = { objects: 0, bytes: 0, byKind: { blob: 0, "config-tree": 0, "change-chunk": 0, commit: 0 } };
    const summary = summarizeRepositorySpace({
      categories: { active: category, conflict: category, history: category, orphan: { ...category, objects: 2, bytes: 3 } },
      uniqueBytes: 3,
      reachableBytes: 0,
      uniqueReferencedBlobBytes: 0,
      logicalReferencedBytes: 0,
      dedupSavedBytes: 0,
      historyGrowthBytes: 0,
      orphanKeys: ["private/object/one", "private/object/two"],
    });
    expect(summary.categories.orphan).toMatchObject({ objects: 2, bytes: 3 });
    expect(summary).not.toHaveProperty("orphanKeys");
  });
});
