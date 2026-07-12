import { describe, expect, it } from "vitest";
import { inspectWriterChain } from "../../core/writer-chain";

describe("writer commit chain", () => {
  it("detects gaps, wrong predecessors and forks without selecting a branch", () => {
    const one = "00000000000000000001";
    const two = "00000000000000000002";
    expect(inspectWriterChain([{ sequence: one, hash: "a", previousCommitHash: null }, { sequence: two, hash: "b", previousCommitHash: "a" }])).toEqual([]);
    expect(inspectWriterChain([{ sequence: two, hash: "b", previousCommitHash: "a" }])).toEqual(["previous-mismatch", "sequence-gap"]);
    expect(inspectWriterChain([{ sequence: one, hash: "a", previousCommitHash: null }, { sequence: one, hash: "b", previousCommitHash: null }])).toEqual(["sequence-fork"]);
  });
});
