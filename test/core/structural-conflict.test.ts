import { describe, expect, it } from "vitest";
import { findStructuralConflicts } from "../../core/structural-conflict";

describe("structural path conflicts", () => {
  it("preserves both heads for file-directory collisions", () => {
    expect(findStructuralConflicts([{ path: "foo", versionId: "file" }, { path: "foo/bar.md", versionId: "child" }, { path: "other.md", versionId: "other" }])).toEqual([
      { paths: ["foo", "foo/bar.md"], heads: ["child", "file"] },
    ]);
  });
});
