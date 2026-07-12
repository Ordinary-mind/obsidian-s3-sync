import { describe, expect, it } from "vitest";
import { observeStableDisk } from "../../core/editor-latch";
describe("editor write latch", () => { it("does not guess external concurrency from a mismatched disk value", () => {
  const latch = { generation: 1, expectedContentHash: "editor", awaitingLocalWrite: true };
  expect(observeStableDisk(latch, "old-projection", false)).toBe("keep-waiting");
  expect(observeStableDisk(latch, "editor", false)).toBe("editor-write-proven");
  expect(observeStableDisk(latch, "external", true)).toBe("local-concurrent");
}); });
