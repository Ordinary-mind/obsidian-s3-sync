import { describe, expect, it } from "vitest";
import { conflictMetadataPath, conflictVersionCopyPath, remoteConflictCopyPath } from "../../core/conflict-copy";

describe("remote conflict copy path", () => {
  it("uses the permanently excluded Vault root and content address", () => {
    expect(remoteConflictCopyPath("a".repeat(64), "b".repeat(64))).toBe(`.s3-sync-conflicts/${"a".repeat(64)}/remote-${"b".repeat(64)}`);
  });
  it("never exposes a raw Version ID as a platform filename", () => {
    const conflict = "a".repeat(64);
    const path = conflictVersionCopyPath(conflict, `${"b".repeat(64)}:12:34`);
    expect(path).toMatch(/^\.s3-sync-conflicts\/[0-9a-f]{64}\/put-[0-9a-f]{64}$/);
    expect(path).not.toContain(":12:34");
    expect(conflictMetadataPath(conflict)).toBe(`.s3-sync-conflicts/${conflict}/metadata.json`);
  });
});
