import { describe, expect, it } from "vitest";
import { classifyAnchorRead } from "../../core/anchor";
describe("repository anchor", () => { it("does not confuse unknown emptiness with missing known integrity anchors", () => {
  expect(classifyAnchorRead({ hasObservedAnchor: false, directlyReadable: false, retryExhausted: false })).toBe("unknown-empty");
  expect(classifyAnchorRead({ hasObservedAnchor: true, directlyReadable: false, retryExhausted: true })).toBe("integrity-stopped");
}); });
