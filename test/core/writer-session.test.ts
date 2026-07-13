import { describe, expect, it } from "vitest";
import { recordPublishedWriterCommit, reserveWriterCommit, rotateWriterAfterFork } from "../../core/writer-session";
import { nextDirtyGeneration } from "../../core/dirty-record";

describe("writer session", () => {
  it("reserves a stable sequence and advances only after a verified Commit", () => {
    const session = { writerId: "writer", nextSequence: "00000000000000000001", previousCommitHash: null };
    expect(reserveWriterCommit(session)).toEqual({ sequence: "00000000000000000001", previousCommitHash: null });
    expect(recordPublishedWriterCommit(session, "a".repeat(64))).toEqual({ writerId: "writer", nextSequence: "00000000000000000002", previousCommitHash: "a".repeat(64) });
  });
  it("rotates after uint64 maximum while preserving an old exact local predecessor", () => {
    const exhausted = { writerId: "old-writer", nextSequence: "18446744073709551615", previousCommitHash: "a".repeat(64) };
    const rotated = recordPublishedWriterCommit(exhausted, "b".repeat(64), () => "new-writer");
    expect(rotated).toEqual({ writerId: "new-writer", nextSequence: "00000000000000000001", previousCommitHash: null });
    expect(reserveWriterCommit(rotated).previousCommitHash).toBeNull();
    const dirty = nextDirtyGeneration("notes/a.md", 2, { path: "notes/a.md", queueId: "notes/a.md", versionId: `${"b".repeat(64)}:0:0` });
    expect(dirty.localPredecessorVersion).toBe(`${"b".repeat(64)}:0:0`);
  });
  it("rotates a forked writer only after its Outbox is drained", () => {
    const session = { writerId: "forked", nextSequence: "00000000000000000003", previousCommitHash: "a".repeat(64) };
    expect(() => rotateWriterAfterFork(session, "replacement", false)).toThrow("drained Outbox");
    expect(rotateWriterAfterFork(session, "replacement", true)).toEqual({ writerId: "replacement", nextSequence: "00000000000000000001", previousCommitHash: null });
  });
});
