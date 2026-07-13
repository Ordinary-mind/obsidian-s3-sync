import { describe, expect, it } from "vitest";
import { assertStagingReferenceBelowStateRoot, planStagingCleanup } from "../../core/content-retention";
import { createRecoveryRecord } from "../../core/recovery-record";

describe("content staging retention", () => {
  it("retains every causal reference and never automatically removes recovery content", () => {
    const recovery = createRecoveryRecord({ id: "r", contentRef: "recovery", logicalPath: "a", source: "post-capture-edit", hash: "a".repeat(64), size: 1, capturedAt: 1 });
    const plan = planStagingCleanup(["unused", "dirty", "outbox", "recovery"], {
      dirtyRecords: ["dirty"], localConcurrentRecords: [], outbox: ["outbox"], publishedReconciles: [], conflictDrafts: [], journals: [], recoveryRecords: [recovery],
    });
    expect(plan).toEqual({ retained: ["dirty", "outbox", "recovery"], removable: ["unused"] });
  });

  it("rejects references outside the repository state root", () => {
    expect(() => assertStagingReferenceBelowStateRoot(".obsidian/.obsidian-s3-sync-local/repo", ".obsidian/.obsidian-s3-sync-local/repo/staged/a")).not.toThrow();
    expect(() => assertStagingReferenceBelowStateRoot("state/repo", "state/other/a")).toThrow("escapes");
    expect(() => assertStagingReferenceBelowStateRoot("state/repo", "state/repo/../other")).toThrow("invalid");
  });
});
