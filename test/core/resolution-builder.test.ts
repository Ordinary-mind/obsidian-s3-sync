import { describe, expect, it } from "vitest";
import { buildResolutionMutation } from "../../core/resolution-builder";
import { captureConflictResolution } from "../../core/resolution";
describe("resolution mutation builder", () => { it("refuses stale resolution parent sets", () => {
  const intent = captureConflictResolution("notes/a.md", ["a", "b"], "value");
  expect(buildResolutionMutation(intent, ["b", "a"])).toMatchObject({ parents: ["a", "b"] });
  expect(() => buildResolutionMutation(intent, ["a", "b", "later"])).toThrow("conflict set changed");
}); });
