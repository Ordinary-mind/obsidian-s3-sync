import { describe, expect, it } from "vitest";
import { conflictId } from "../../core/conflict-id";

describe("stable conflict IDs", () => {
  it("is independent of head and path enumeration order", () => {
    expect(conflictId("repo", "vault", ["b", "a"], ["h2", "h1"])).toBe(conflictId("repo", "vault", ["a", "b"], ["h1", "h2"]));
  });
});
