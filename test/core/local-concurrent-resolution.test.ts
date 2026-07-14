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

  it("persists the user's selection and blocks automatic work until it is published", () => {
    const selected = selectLocalConcurrentRecordResolution({ record, choice: "editor" });
    expect(selected.selection).toMatchObject({ choice: "editor", state: "selected", parents: ["old-projected"] });
    expect(localConcurrentRecordBlocksAutomaticWork(selected)).toBe(true);
    const published = markLocalConcurrentSelectionPublished(selected);
    expect(localConcurrentRecordBlocksAutomaticWork(published)).toBe(false);
  });
});
