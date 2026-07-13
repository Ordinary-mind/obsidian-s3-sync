import { describe, expect, it } from "vitest";
import { registerVersionsFromEnvelope } from "../../core/ingest";

describe("verified envelope ingestion", () => {
  it("derives deterministic Version IDs and one Config logical register", () => {
    const hash = "a".repeat(64);
    const commit = { repositoryId: "repo", channel: "config" } as any;
    const chunks = [{ mutations: [{ parents: [] }] }] as any;
    expect(registerVersionsFromEnvelope(hash, commit, chunks)).toEqual([{ repositoryId: "repo", channel: "config", logicalKey: "portable", versionId: `${hash}:0:0`, parents: [] }]);
  });
  it("retains the verified Vault Blob reference needed by a receiver", () => {
    const versions = registerVersionsFromEnvelope("a".repeat(64), { repositoryId: "repo", channel: "vault" } as any, [{ mutations: [{ path: "notes/a.md", kind: "put", blobHash: "b".repeat(64), size: 3, parents: [] }] }] as any);
    expect(versions[0].blob).toEqual({ hash: "b".repeat(64), size: 3 });
  });
  it("isolates excluded Vault roots without dropping legal sibling Mutations", () => {
    const commit = { repositoryId: "repo", channel: "vault" } as any;
    const chunks = [{ mutations: [
      { path: ".obsidian/app.json", kind: "put", blobHash: "a".repeat(64), size: 1, parents: [] },
      { path: ".s3-sync-conflicts/copy.md", kind: "put", blobHash: "b".repeat(64), size: 1, parents: [] },
      { path: "notes/kept.md", kind: "put", blobHash: "c".repeat(64), size: 1, parents: [] },
    ] }] as any;
    const versions = registerVersionsFromEnvelope("d".repeat(64), commit, chunks, new Map(), { configDir: ".obsidian", historicalConfigDirs: [".old-config"] });
    expect(versions).toHaveLength(1);
    expect(versions[0].logicalKey).toBe("notes/kept.md");
    expect(versions[0].versionId).toBe(`${"d".repeat(64)}:0:2`);
  });
});
