import { describe, expect, it } from "vitest";
import { captureConflictResolution, isResolutionCurrent } from "../../core/resolution";

describe("conflict resolution intent", () => {
  it("freezes every observed head and selected content", () => {
    const intent = captureConflictResolution("notes/a.md", ["b", "a", "a"], "blob");
    expect(intent).toEqual({ path: "notes/a.md", parents: ["a", "b"], selectedValueHash: "blob" });
    expect(Object.isFrozen(intent)).toBe(true);
  });
  it("expires when a newly observed head changes the conflict set", () => {
    const intent = captureConflictResolution("notes/a.md", ["a", "b"], "blob");
    expect(isResolutionCurrent(intent, ["b", "a"])).toBe(true);
    expect(isResolutionCurrent(intent, ["a", "b", "later"])).toBe(false);
  });
});
