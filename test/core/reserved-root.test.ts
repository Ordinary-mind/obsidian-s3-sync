import { describe, expect, it } from "vitest";
import {
  assessReservedRoot,
  createReservedRootMetadata,
  encodeReservedRootMetadata,
  parseReservedRootMetadata,
} from "../../core/reserved-root";

const repositoryId = "123e4567-e89b-42d3-a456-426614174000";

describe("reserved local root ownership", () => {
  it("uses only a directory with matching canonical ownership metadata", () => {
    const expected = createReservedRootMetadata("repository-state", repositoryId);
    const metadata = encodeReservedRootMetadata(expected);
    expect(parseReservedRootMetadata(metadata)).toEqual(expected);
    expect(assessReservedRoot({ type: "directory", metadata }, expected)).toEqual({ decision: "use" });
    expect(assessReservedRoot({ type: "missing" }, expected)).toEqual({ decision: "create" });
  });

  it("refuses files, unsafe nodes, missing metadata, and another repository owner", () => {
    const expected = createReservedRootMetadata("repository-state", repositoryId);
    const other = encodeReservedRootMetadata(createReservedRootMetadata("repository-state", "123e4567-e89b-42d3-a456-426614174001"));
    expect(assessReservedRoot({ type: "file" }, expected)).toEqual({ decision: "refuse", reason: "not-directory" });
    for (const type of ["symlink", "reparse-point", "unknown"] as const) {
      expect(assessReservedRoot({ type }, expected)).toEqual({ decision: "refuse", reason: "unsafe-node" });
    }
    expect(assessReservedRoot({ type: "directory" }, expected)).toEqual({ decision: "refuse", reason: "metadata-missing" });
    expect(assessReservedRoot({ type: "directory", metadata: other }, expected)).toEqual({ decision: "refuse", reason: "metadata-mismatch" });
  });

  it("rejects malformed, non-canonical, and wrong-kind metadata", () => {
    const expected = createReservedRootMetadata("vault-conflicts");
    const malformed = new TextEncoder().encode('{"owner":"obsidian-s3-sync"}');
    const wrongKind = encodeReservedRootMetadata(createReservedRootMetadata("repository-state", repositoryId));
    expect(assessReservedRoot({ type: "directory", metadata: malformed }, expected)).toEqual({ decision: "refuse", reason: "metadata-invalid" });
    expect(assessReservedRoot({ type: "directory", metadata: wrongKind }, expected)).toEqual({ decision: "refuse", reason: "metadata-mismatch" });
  });
});
