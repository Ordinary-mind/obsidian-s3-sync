import { describe, expect, it } from "vitest";
import { findCaseAliasConflicts, findStructuralConflicts } from "../../core/structural-conflict";
import { vaultPathCaseFoldKey } from "../../core/path";

describe("structural path conflicts", () => {
  it("preserves both heads for file-directory collisions", () => {
    expect(findStructuralConflicts([{ path: "foo", versionId: "file" }, { path: "foo/bar.md", versionId: "child" }, { path: "other.md", versionId: "other" }])).toEqual([
      { paths: ["foo", "foo/bar.md"], heads: ["child", "file"] },
    ]);
  });
  it("reports case-fold aliases without choosing a platform-specific winner", () => {
    expect(findCaseAliasConflicts([{ path: "Foo.md", versionId: "upper" }, { path: "foo.md", versionId: "lower" }], (path) => path.toLowerCase())).toEqual([
      { paths: ["Foo.md", "foo.md"], heads: ["lower", "upper"] },
    ]);
  });
  it("uses frozen case folding for special characters independently of locale", () => {
    expect(findCaseAliasConflicts([
      { path: "Notes/STRASSE.md", versionId: "ascii" },
      { path: "notes/straße.md", versionId: "sharp-s" },
    ], vaultPathCaseFoldKey)).toEqual([
      { paths: ["Notes/STRASSE.md", "notes/straße.md"], heads: ["ascii", "sharp-s"] },
    ]);
  });
});
