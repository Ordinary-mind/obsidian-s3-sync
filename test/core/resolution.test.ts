import { describe, expect, it } from "vitest";
import {
  captureConflictResolution,
  captureConflictResolutionCommand,
  encodeConflictResolutionIntent,
  isResolutionCurrent,
  parseConflictResolutionIntent,
} from "../../core/resolution";

describe("conflict resolution intent", () => {
  it("freezes every observed head and selected content", () => {
    const selected = { kind: "put" as const, hash: "blob", stagedRef: "staged/original" };
    const intent = captureConflictResolution("notes/a.md", ["b", "a", "a"], selected);
    selected.hash = "changed";
    expect(intent).toEqual({
      path: "notes/a.md",
      parents: ["a", "b"],
      selectedValue: { kind: "put", hash: "blob", stagedRef: "staged/original" },
      selectedValueHash: "blob",
    });
    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.isFrozen(intent.parents)).toBe(true);
    expect(Object.isFrozen(intent.selectedValue)).toBe(true);
  });
  it("expires when a newly observed head changes the conflict set", () => {
    const intent = captureConflictResolution("notes/a.md", ["a", "b"], "blob");
    expect(isResolutionCurrent(intent, ["b", "a"])).toBe(true);
    expect(isResolutionCurrent(intent, ["a", "b", "later"])).toBe(false);
  });
  it("captures a confirmed delete without inventing a content Hash", () => {
    expect(captureConflictResolution("notes/a.md", ["a", "b"], { kind: "delete" })).toEqual({
      path: "notes/a.md", parents: ["a", "b"], selectedValue: { kind: "delete" },
    });
  });

  it("models local, remote-version, merged, and confirmed-delete commands explicitly", () => {
    const first = `${"1".repeat(64)}:0:0`;
    const second = `${"2".repeat(64)}:0:0`;
    const hash = "a".repeat(64);
    expect(captureConflictResolutionCommand("notes/a.md", [first, second], {
      action: "select-local",
      hash,
      size: 1,
      stagedRef: "conflict-drafts/local",
    })).toMatchObject({ selectionKind: "local", selectedValue: { kind: "put", stagedRef: "conflict-drafts/local" } });
    expect(captureConflictResolutionCommand("notes/a.md", [first, second], {
      action: "select-version",
      versionId: second,
      hash,
      size: 1,
    })).toMatchObject({ selectionKind: "version", selectedVersionId: second });
    expect(captureConflictResolutionCommand("notes/a.md", [first, second], {
      action: "use-merged",
      hash,
      size: 1,
      stagedRef: "conflict-drafts/merged",
    })).toMatchObject({ selectionKind: "merged" });
    expect(captureConflictResolutionCommand("notes/a.md", [first, second], {
      action: "confirm-delete",
      confirmed: true,
    })).toMatchObject({ selectionKind: "delete", selectedValue: { kind: "delete" } });
    expect(() => captureConflictResolutionCommand("notes/a.md", [first], {
      action: "select-version",
      versionId: second,
      hash,
      size: 1,
    })).toThrow("not an observed head");
  });

  it("round-trips a frozen preview across restart without changing its selected bytes", () => {
    const heads = [`${"1".repeat(64)}:0:0`, `${"2".repeat(64)}:0:0`];
    const intent = captureConflictResolutionCommand("notes/a.md", heads, {
      action: "use-merged",
      hash: "a".repeat(64),
      size: 3,
      stagedRef: "conflict-drafts/merged",
    });
    const restored = parseConflictResolutionIntent(encodeConflictResolutionIntent(intent));
    expect(restored).toEqual(intent);
    expect(Object.isFrozen(restored.selectedValue)).toBe(true);
    expect(isResolutionCurrent(restored, [...heads].reverse())).toBe(true);
  });

  it("refuses to persist non-canonical command parents", () => {
    const first = `${"1".repeat(64)}:0:0`;
    const second = `${"2".repeat(64)}:0:0`;
    const intent = captureConflictResolutionCommand("notes/a.md", [first, second], {
      action: "confirm-delete",
      confirmed: true,
    });
    expect(() => encodeConflictResolutionIntent({ ...intent, parents: [second, first] })).toThrow("not canonical");
    expect(() => encodeConflictResolutionIntent({ ...intent, parents: [first, first, second] })).toThrow("not canonical");
  });
});
