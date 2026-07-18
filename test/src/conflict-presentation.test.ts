import { describe, expect, it } from "vitest";
import { groupRemoteConflictCandidates } from "../../src/conflict-presentation";

describe("conflict presentation", () => {
  it("groups identical content and delete candidates without losing a selectable Version ID", () => {
    const hash = "a".repeat(64);
    const groups = groupRemoteConflictCandidates([
      { kind: "put", versionId: "put-1", hash, size: 12 },
      { kind: "put", versionId: "put-2", hash, size: 12 },
      { kind: "put", versionId: "put-3", hash: "b".repeat(64), size: 12 },
      { kind: "delete", versionId: "delete-1" },
      { kind: "delete", versionId: "delete-2" },
    ]);

    expect(groups).toEqual([
      { candidate: { kind: "put", versionId: "put-1", hash, size: 12 }, count: 2 },
      { candidate: { kind: "put", versionId: "put-3", hash: "b".repeat(64), size: 12 }, count: 1 },
      { candidate: { kind: "delete", versionId: "delete-1" }, count: 2 },
    ]);
  });
});
