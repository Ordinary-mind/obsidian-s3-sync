import { describe, expect, it } from "vitest";
import { classifyDeletionObservation, classifyLocalPresence, isStableRead, unsupportedLocalNodeCapabilities } from "../../core/stable-read";
describe("stable local reads", () => { it("requires two equal full observations and never calls non-files absent", () => {
  expect(isStableRead({ type: "file", size: 1, hash: "a" }, { type: "file", size: 1, hash: "a" })).toBe(true);
  expect(isStableRead({ type: "file", size: 1, hash: "a" }, { type: "file", size: 2, hash: "b" })).toBe(false);
  expect(classifyDeletionObservation({ type: "other" })).toBe("unknown");
});
it("maps unsafe node types and observation failures to unknown", () => {
  expect(classifyLocalPresence({ type: "file", size: 1, hash: "a" })).toBe("present");
  expect(classifyLocalPresence({ type: "missing" })).toBe("confirmed-absent");
  expect(classifyLocalPresence({ type: "out-of-scope" })).toBe("out-of-scope");
  for (const type of ["directory", "symlink", "reparse-point", "unsafe", "error", "too-large", "incompatible-path", "scan-incomplete", "other"] as const) {
    expect(classifyLocalPresence({ type })).toBe("unknown");
    expect(classifyDeletionObservation({ type })).toBe("unknown");
  }
});
it("reports unsupported node inspection capabilities explicitly", () => {
  expect(unsupportedLocalNodeCapabilities({ detectSymlink: false, detectReparsePoint: true, safeEnumeration: false })).toEqual([
    "symlink-detection",
    "safe-enumeration",
  ]);
}); });
