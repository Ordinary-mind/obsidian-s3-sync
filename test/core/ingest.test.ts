import { describe, expect, it } from "vitest";
import { registerVersionsFromEnvelope } from "../../core/ingest";

describe("verified envelope ingestion", () => {
  it("derives deterministic Version IDs and one Config logical register", () => {
    const hash = "a".repeat(64);
    const commit = { repositoryId: "repo", channel: "config" } as any;
    const chunks = [{ mutations: [{ parents: [] }] }] as any;
    expect(registerVersionsFromEnvelope(hash, commit, chunks)).toEqual([{ repositoryId: "repo", channel: "config", logicalKey: "portable", versionId: `${hash}:0:0`, parents: [] }]);
  });
});
