import { describe, expect, it } from "vitest";
import {
  conflictCopyContentMatches,
  conflictMetadataPath,
  conflictVersionCopyPath,
  remoteConflictCopyPath,
} from "../../core/conflict-copy";
import { sha256Hex } from "../../protocol/hash";

describe("remote conflict copy path", () => {
  it("uses the permanently excluded Vault root and content address", () => {
    expect(remoteConflictCopyPath("a".repeat(64), "b".repeat(64))).toBe(`.s3-sync-conflicts/${"a".repeat(64)}/remote-${"b".repeat(64)}`);
  });
  it("never exposes a raw Version ID as a platform filename", () => {
    const conflict = "a".repeat(64);
    const path = conflictVersionCopyPath(conflict, `${"b".repeat(64)}:12:34`, "notes/example.md");
    expect(path).toMatch(/^\.s3-sync-conflicts\/[0-9a-f]{64}\/put-[0-9a-f]{64}\.md$/);
    expect(path).not.toContain(":12:34");
    expect(conflictMetadataPath(conflict)).toBe(`.s3-sync-conflicts/${conflict}/metadata.json`);
  });
  it("keeps only safe preview extensions and verifies candidate bytes", () => {
    const conflict = "a".repeat(64);
    const version = `${"b".repeat(64)}:0:0`;
    expect(conflictVersionCopyPath(conflict, version, "asset.canvas")).toMatch(/\.canvas$/);
    expect(conflictVersionCopyPath(conflict, version, "asset.unsafe extension")).not.toContain("unsafe extension");

    const bytes = new TextEncoder().encode("candidate");
    const expected = { hash: sha256Hex(bytes), size: bytes.byteLength };
    expect(conflictCopyContentMatches(bytes, expected)).toBe(true);
    expect(conflictCopyContentMatches(new TextEncoder().encode("changed"), expected)).toBe(false);
    expect(conflictCopyContentMatches(bytes, { ...expected, size: expected.size + 1 })).toBe(false);
  });
});
