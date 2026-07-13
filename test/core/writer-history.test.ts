import { describe, expect, it } from "vitest";
import { WriterHistory } from "../../core/writer-history";
describe("writer history", () => { it("retains a fork for diagnosis instead of replacing a prior Commit", () => {
  const history = new WriterHistory();
  history.ingest({ sequence: "00000000000000000001", hash: "a", previousCommitHash: null });
  expect(history.ingest({ sequence: "00000000000000000001", hash: "b", previousCommitHash: null })).toEqual(["sequence-fork"]);
  expect(history.snapshot()).toHaveLength(2);
  expect(history.requiresRotation()).toBe(true);
}); });
