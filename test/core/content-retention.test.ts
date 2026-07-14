import { describe, expect, it } from "vitest";
import {
  assertStagingReferenceBelowStateRoot,
  collectStagingReachabilityFromRepositoryState,
  planRepositoryStagingCleanup,
  planStagingCleanup,
} from "../../core/content-retention";
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

  it("derives reachability from every durable causal owner instead of trusting a caller-maintained count", () => {
    const recovery = createRecoveryRecord({ id: "r", contentRef: "recovery/r", logicalPath: "a", source: "post-capture-edit", hash: "a".repeat(64), size: 1, capturedAt: 1 });
    const state = {
      dirtyIntents: { "a.md": { value: { kind: "put", stagedPath: "staged/dirty" } } },
      localConcurrentRecords: { "b.md": { editorValue: { kind: "put", stagedPath: "staged/editor" }, externalValue: { kind: "delete" } } },
      durableOutbox: [{ objects: [{ contentRef: "staged/outbox" }], mutations: [] }],
      publishedReconciles: [{ stagedContentRef: "staged/reconcile" }],
      conflictDrafts: { one: { contentRef: "conflict-drafts/one" } },
      applyJournals: [{ recoveryRef: "recovery/journal" }],
      recoveryRecords: { r: recovery },
    };
    const reachability = collectStagingReachabilityFromRepositoryState(state);
    expect(reachability.dirtyRecords).toEqual(["staged/dirty"]);
    expect(reachability.localConcurrentRecords).toEqual(["staged/editor"]);
    expect(planRepositoryStagingCleanup([
      "staged/dirty", "staged/editor", "staged/outbox", "staged/reconcile",
      "conflict-drafts/one", "recovery/journal", "recovery/r", "staged/free",
    ], state).removable).toEqual(["staged/free"]);
  });
});
