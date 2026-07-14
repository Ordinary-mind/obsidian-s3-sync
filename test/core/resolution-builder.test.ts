import { describe, expect, it } from "vitest";
import { buildResolutionMutation } from "../../core/resolution-builder";
import { captureConflictResolution, captureConflictResolutionCommand } from "../../core/resolution";
describe("resolution mutation builder", () => { it("refuses stale resolution parent sets", () => {
  const intent = captureConflictResolution("notes/a.md", ["a", "b"], "value");
  expect(buildResolutionMutation(intent, ["b", "a"])).toMatchObject({ parents: ["a", "b"] });
  expect(() => buildResolutionMutation(intent, ["a", "b", "later"])).toThrow("conflict set changed");
});
it("revalidates staged local or merged bytes after preview", () => {
  const heads = [`${"1".repeat(64)}:0:0`, `${"2".repeat(64)}:0:0`];
  const intent = captureConflictResolutionCommand("notes/a.md", heads, {
    action: "use-merged",
    hash: "a".repeat(64),
    size: 3,
    stagedRef: "conflict-drafts/merged",
  });
  expect(() => buildResolutionMutation(intent, heads)).toThrow("selected conflict content changed");
  expect(() => buildResolutionMutation(intent, heads, {
    hash: "b".repeat(64), size: 3, stagedRef: "conflict-drafts/merged",
  })).toThrow("selected conflict content changed");
  expect(buildResolutionMutation(intent, heads, {
    hash: "a".repeat(64), size: 3, stagedRef: "conflict-drafts/merged",
  })).toMatchObject({ kind: "put", valueHash: "a".repeat(64), size: 3, stagedRef: "conflict-drafts/merged" });
}); });
