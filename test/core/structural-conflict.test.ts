import { describe, expect, it } from "vitest";
import {
  findCaseAliasConflicts,
  findStructuralConflicts,
  structuralConflictBlocksPath,
  structuralConflictId,
} from "../../core/structural-conflict";
import { vaultPathCaseFoldKey } from "../../core/path";

describe("structural path conflicts", () => {
  it("preserves both heads for file-directory collisions", () => {
    expect(findStructuralConflicts([{ path: "foo", versionId: "file" }, { path: "foo/bar.md", versionId: "child" }, { path: "other.md", versionId: "other" }])).toEqual([
      { paths: ["foo", "foo/bar.md"], heads: ["child", "file"] },
    ]);
  });
  it("groups a whole affected subtree under one stable cross-path identity", () => {
    const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
    const version = (digit: string) => `${digit.repeat(64)}:0:0`;
    const heads = [
      { path: "foo/bar.md", versionId: version("2") },
      { path: "other.md", versionId: version("4") },
      { path: "foo", versionId: version("1") },
      { path: "foo/nested/baz.md", versionId: version("3") },
    ];
    const conflict = findStructuralConflicts(heads)[0];
    expect(conflict).toEqual({
      paths: ["foo", "foo/bar.md", "foo/nested/baz.md"],
      heads: [version("1"), version("2"), version("3")],
    });
    expect(structuralConflictId(repositoryId, conflict)).toBe(structuralConflictId(repositoryId, {
      paths: [...conflict.paths].reverse(),
      heads: [...conflict.heads].reverse(),
    }));
    expect(structuralConflictBlocksPath(conflict, "foo/new/child.md")).toBe(true);
    expect(structuralConflictBlocksPath(conflict, "other.md")).toBe(false);
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
