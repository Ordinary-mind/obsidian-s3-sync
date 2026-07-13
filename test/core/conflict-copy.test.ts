import { describe, expect, it } from "vitest";
import { remoteConflictCopyPath } from "../../core/conflict-copy";

describe("remote conflict copy path", () => {
  it("uses the permanently excluded Vault root and content address", () => {
    expect(remoteConflictCopyPath("a".repeat(64), "b".repeat(64))).toBe(`.s3-sync-conflicts/${"a".repeat(64)}/remote-${"b".repeat(64)}`);
  });
});
