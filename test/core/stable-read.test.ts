import { describe, expect, it } from "vitest";
import { classifyDeletionObservation, isStableRead } from "../../core/stable-read";
describe("stable local reads", () => { it("requires two equal full observations and never calls non-files absent", () => {
  expect(isStableRead({ type: "file", size: 1, hash: "a" }, { type: "file", size: 1, hash: "a" })).toBe(true);
  expect(isStableRead({ type: "file", size: 1, hash: "a" }, { type: "file", size: 2, hash: "b" })).toBe(false);
  expect(classifyDeletionObservation({ type: "other" })).toBe("unknown");
}); });
