import { describe, expect, it } from "vitest";
import { advanceIngestedCommitState } from "../../core/ingested-state";
import type { CommitFrontierAnchor } from "../../core/commit-frontier";

describe("ingested Commit frontier and sparse seen commits", () => {
  const writerId = "123e4567-e89b-42d3-a456-426614174001";
  const anchor = (sequence: string, hash: string, previousCommitHash: string | null): CommitFrontierAnchor => ({ key: `commit-${hash}`, writerId, sequence, hash, previousCommitHash });

  it("keeps a gap successor sparse and promotes it when the missing Commit arrives", () => {
    const first = anchor("00000000000000000001", "a".repeat(64), null);
    const second = anchor("00000000000000000002", "b".repeat(64), first.hash);
    const third = anchor("00000000000000000003", "c".repeat(64), second.hash);
    const withGap = advanceIngestedCommitState({ frontiers: {}, sparseSeenCommits: {} }, [first, third]);
    expect(withGap.frontiers[writerId]).toEqual([first]);
    expect(Object.keys(withGap.sparseSeenCommits)).toEqual([third.hash]);
    const repaired = advanceIngestedCommitState(withGap, [second]);
    expect(repaired.frontiers[writerId]).toEqual([third]);
    expect(repaired.sparseSeenCommits).toEqual({});
  });
});
