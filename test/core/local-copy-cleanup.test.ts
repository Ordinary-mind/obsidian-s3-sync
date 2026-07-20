import { describe, expect, it } from "vitest";
import { selectCleanableRecoveryRecords } from "../../core/local-copy-cleanup";
import { createRecoveryRecord, requestRecoveryCleanup, type RecoveryRecord } from "../../core/recovery-record";

const HASH = "a".repeat(64);

function recovery(overrides: Partial<RecoveryRecord> = {}): RecoveryRecord {
  return {
    ...createRecoveryRecord({
      id: "operation-1",
      contentRef: "recovery/operation-1",
      logicalPath: "notes/example.md",
      source: "apply-before-image",
      hash: HASH,
      size: 12,
      capturedAt: 1,
    }),
    ...overrides,
  };
}

describe("selectCleanableRecoveryRecords", () => {
  it("selects a resolved apply before-image", () => {
    const record = recovery();
    expect(selectCleanableRecoveryRecords({
      records: [record],
      applyJournals: [],
      conflicts: [{ path: record.logicalPath, resolved: true }],
    })).toEqual({ eligible: [record], protected: [] });
  });

  it("protects records referenced by conflicts or active journals", () => {
    const record = recovery();
    const cases: Array<{
      applyJournals?: Array<{ operationId: string; path: string }>;
      conflicts?: Array<{ path: string; resolved: boolean }>;
    }> = [
      { conflicts: [{ path: "notes/example.md", resolved: false }] },
      { applyJournals: [{ operationId: "operation-1", path: "other.md" }] },
      { applyJournals: [{ operationId: "other", path: "notes/example.md" }] },
    ];
    for (const input of cases) {
      expect(selectCleanableRecoveryRecords({
        records: [record],
        applyJournals: input.applyJournals ?? [],
        conflicts: input.conflicts ?? [],
      })).toEqual({ eligible: [], protected: [record] });
    }
  });

  it("protects edited and non-apply recovery sources", () => {
    const edited = recovery({ id: "edited", contentRef: "recovery/edited", postCaptureEdit: true });
    const rollback = recovery({ id: "rollback", contentRef: "recovery/rollback", source: "config-rollback" });
    expect(selectCleanableRecoveryRecords({
      records: [edited, rollback],
      applyJournals: [],
      conflicts: [],
    })).toEqual({ eligible: [], protected: [edited, rollback] });
  });

  it("protects a shared content reference when any owner still needs it", () => {
    const eligibleOwner = recovery();
    const protectedOwner = recovery({
      id: "protected",
      logicalPath: "notes/unresolved.md",
    });
    expect(selectCleanableRecoveryRecords({
      records: [eligibleOwner, protectedOwner],
      applyJournals: [],
      conflicts: [{ path: protectedOwner.logicalPath, resolved: false }],
    })).toEqual({ eligible: [], protected: [eligibleOwner, protectedOwner] });
  });

  it("ignores cleaned records and resumes cleanup-requested records", () => {
    const requested = requestRecoveryCleanup(recovery(), {
      explicit: true,
      reviewedHash: HASH,
      reviewedSize: 12,
    });
    const cleaned = recovery({ id: "cleaned", contentRef: "recovery/cleaned", cleanupState: "cleaned" });
    expect(selectCleanableRecoveryRecords({
      records: [requested, cleaned],
      applyJournals: [],
      conflicts: [],
    })).toEqual({ eligible: [requested], protected: [] });
  });
});
