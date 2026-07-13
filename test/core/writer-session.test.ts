import { describe, expect, it } from "vitest";
import { recordPublishedWriterCommit, reserveWriterCommit } from "../../core/writer-session";

describe("writer session", () => {
  it("reserves a stable sequence and advances only after a verified Commit", () => {
    const session = { writerId: "writer", nextSequence: "00000000000000000001", previousCommitHash: null };
    expect(reserveWriterCommit(session)).toEqual({ sequence: "00000000000000000001", previousCommitHash: null });
    expect(recordPublishedWriterCommit(session, "a".repeat(64))).toEqual({ writerId: "writer", nextSequence: "00000000000000000002", previousCommitHash: "a".repeat(64) });
  });
});
