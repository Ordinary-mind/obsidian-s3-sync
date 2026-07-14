import { describe, expect, it } from "vitest";
import { canonicalConflictIdentity, conflictId } from "../../core/conflict-id";

describe("stable conflict IDs", () => {
  const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
  const head = (value: string) => `${value.repeat(64)}:0:0`;

  it("is independent of head and path enumeration order", () => {
    const left = conflictId(repositoryId, "vault", ["vault:b", "vault:a"], [head("2"), head("1")]);
    const right = conflictId(repositoryId, "vault", ["vault:a", "vault:b"], [head("1"), head("2")]);
    expect(left).toBe(right);
    expect(canonicalConflictIdentity(repositoryId, "vault", ["vault:b", "vault:a"], [head("2"), head("1")])).toEqual({
      protocol: 1,
      repositoryId,
      channel: "vault",
      logicalKeys: ["vault:a", "vault:b"],
      heads: [head("1"), head("2")],
    });
  });
  it("uses UTF-8 ordering rather than locale ordering", () => {
    expect(conflictId(repositoryId, "vault", ["vault:ä", "vault:z"], [head("2"), head("1")])).toBe(
      conflictId(repositoryId, "vault", ["vault:z", "vault:ä"], [head("1"), head("2")]),
    );
  });
  it("rejects non-canonical repository, logical-key, and Version ID input", () => {
    expect(() => conflictId("repo", "vault", ["vault:a"], [head("1")])).toThrow("repositoryId");
    expect(() => conflictId(repositoryId, "other" as "vault", ["vault:a"], [head("1")])).toThrow("channel");
    expect(() => conflictId(repositoryId, "vault", ["a"], [head("1")])).toThrow("logical key");
    expect(() => conflictId(repositoryId, "config", ["config:other"], [head("1")])).toThrow("logical key");
    expect(() => conflictId(repositoryId, "vault", ["vault:a"], ["not-a-version"])).toThrow("Version ID");
  });
});
