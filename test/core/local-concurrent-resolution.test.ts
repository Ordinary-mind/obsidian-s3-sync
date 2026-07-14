import { describe, expect, it } from "vitest";
import {
  localConcurrentRecordBlocksAutomaticWork,
  markLocalConcurrentSelectionPublished,
  resolveLocalConcurrentRecord,
  selectLocalConcurrentRecordResolution,
} from "../../core/local-concurrent-resolution";
import type { LocalConcurrentRecord } from "../../core/dirty-record";

describe("LocalConcurrentRecord resolution", () => {
  const record: LocalConcurrentRecord = {
    path: "a.md",
    generation: 2,
    basisHeads: ["old-projected"],
    editorValue: { kind: "put", blob: { hash: "a".repeat(64), size: 1 }, stagedPath: "staged/editor" },
    externalValue: { kind: "put", blob: { hash: "b".repeat(64), size: 1 }, stagedPath: "staged/external" },
  };

  it("inherits only the record's original basis and retains unselected bytes", () => {
    const resolved = resolveLocalConcurrentRecord({ record, choice: "editor" });
    expect(resolved).toMatchObject({ path: "a.md", parents: ["old-projected"], value: record.editorValue, unselectedContentRefs: ["staged/external"] });
  });

  it("requires an explicitly staged merge or confirmed deletion evidence", () => {
    expect(() => resolveLocalConcurrentRecord({ record, choice: "merged" })).toThrow("staged");
    expect(() => resolveLocalConcurrentRecord({ record, choice: "delete", confirmedDelete: record.editorValue })).toThrow("confirmed deletion");
  });

  it("supports external, merged, and delete choices while retaining every unselected put", () => {
    expect(resolveLocalConcurrentRecord({ record, choice: "external" })).toMatchObject({
      value: record.externalValue,
      unselectedContentRefs: ["staged/editor"],
    });
    const mergedValue = { kind: "put" as const, blob: { hash: "c".repeat(64), size: 2 }, stagedPath: "recovery/merged" };
    expect(resolveLocalConcurrentRecord({ record, choice: "merged", mergedValue })).toMatchObject({
      value: mergedValue,
      unselectedContentRefs: ["staged/editor", "staged/external"],
    });
    const confirmedDelete = {
      kind: "delete" as const,
      evidence: { path: "a.md", scopeRevision: "scope-2", confirmedAt: 3 },
    };
    expect(resolveLocalConcurrentRecord({ record, choice: "delete", confirmedDelete })).toMatchObject({
      value: confirmedDelete,
      parents: ["old-projected"],
      unselectedContentRefs: ["staged/editor", "staged/external"],
    });
  });

  it("persists the user's selection and blocks automatic work until it is published", () => {
    const selected = selectLocalConcurrentRecordResolution({ record, choice: "editor" });
    expect(selected.selection).toMatchObject({ choice: "editor", state: "selected", parents: ["old-projected"] });
    expect(localConcurrentRecordBlocksAutomaticWork(selected)).toBe(true);
    const published = markLocalConcurrentSelectionPublished(selected);
    expect(localConcurrentRecordBlocksAutomaticWork(published)).toBe(false);
  });
});
