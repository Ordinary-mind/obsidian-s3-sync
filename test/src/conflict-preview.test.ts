import { describe, expect, it } from "vitest";
import {
  mayLoadConflictPreview,
  missingConflictPreview,
  oversizedConflictPreview,
  previewConflictBytes,
} from "../../src/conflict-preview";

const utf8 = (value: string) => new TextEncoder().encode(value);

describe("conflict whole-file preview", () => {
  it("returns complete UTF-8 text without computing line-level differences", () => {
    const source = "第一行\nsecond line";
    const bytes = utf8(source);
    expect(previewConflictBytes(bytes)).toEqual({
      kind: "text",
      text: source,
      size: bytes.byteLength,
      lines: 2,
    });
  });

  it("classifies binary controls and invalid UTF-8 without exposing replacement text", () => {
    expect(previewConflictBytes(new Uint8Array([65, 0, 66]))).toEqual({
      kind: "unavailable",
      reason: "binary",
      size: 3,
    });
    expect(previewConflictBytes(new Uint8Array([0xc3, 0x28]))).toEqual({
      kind: "unavailable",
      reason: "invalid-utf8",
      size: 2,
    });
  });

  it("bounds bytes and lines before rendering large content", () => {
    expect(previewConflictBytes(utf8("abcd"), { maximumBytes: 3, maximumLines: 10 })).toEqual({
      kind: "unavailable",
      reason: "too-large",
      size: 4,
    });
    expect(previewConflictBytes(utf8("a\nb\nc"), { maximumBytes: 10, maximumLines: 2 })).toEqual({
      kind: "unavailable",
      reason: "too-many-lines",
      size: 5,
      lines: 3,
    });
  });

  it("represents deleted and oversized sides without reading file bytes", () => {
    expect(missingConflictPreview()).toEqual({ kind: "missing", size: 0 });
    expect(oversizedConflictPreview(2_000_000)).toEqual({ kind: "unavailable", reason: "too-large", size: 2_000_000 });
    expect(mayLoadConflictPreview(1024 * 1024)).toBe(true);
    expect(mayLoadConflictPreview(1024 * 1024 + 1)).toBe(false);
  });
});
