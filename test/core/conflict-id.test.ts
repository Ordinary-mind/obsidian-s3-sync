import { describe, expect, it } from "vitest";
import { conflictId } from "../../core/conflict-id";

describe("stable conflict IDs", () => {
  it("is independent of head and path enumeration order", () => {
    expect(conflictId("repo", "vault", ["b", "a"], ["h2", "h1"])).toBe(conflictId("repo", "vault", ["a", "b"], ["h1", "h2"]));
  });
  it("uses UTF-8 ordering rather than locale ordering", () => {
    expect(conflictId("repo", "vault", ["ä", "z"], ["二", "一"])).toBe(conflictId("repo", "vault", ["z", "ä"], ["一", "二"]));
  });
});
