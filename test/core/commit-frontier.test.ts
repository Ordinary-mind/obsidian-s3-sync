import { describe, expect, it } from "vitest";
import { advanceWriterFrontiers, verifyWriterFrontiers, type CommitFrontierAnchor } from "../../core/commit-frontier";
import { canonicalizeProtocolJson } from "../../protocol/json";
import { sha256Hex } from "../../protocol/hash";
import { commitKey } from "../../protocol/keys";
import { objectBodyFromBytes } from "../../core/object-store";

describe("Commit frontier integrity anchors", () => {
  const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
  const writerId = "123e4567-e89b-42d3-a456-426614174001";
  const descriptorHash = "a".repeat(64);

  function anchor(sequence: string, previousCommitHash: string | null): { anchor: CommitFrontierAnchor; bytes: Uint8Array } {
    const bytes = new TextEncoder().encode(canonicalizeProtocolJson({ protocol: 1, repositoryId, descriptorHash, writerId, sequence, previousCommitHash, createdAt: "2026-07-13T00:00:00.000Z", channel: "vault", kind: sequence.endsWith("01") ? "bootstrap" : "change", changeChunkHashes: ["b".repeat(64)], clientVersion: "0.1.0" }));
    const hash = sha256Hex(bytes);
    return { bytes, anchor: { key: commitKey("", repositoryId, writerId, sequence, hash), writerId, sequence, hash, previousCommitHash } };
  }

  it("replaces a parent tip and retains fork tips", () => {
    const first = anchor("00000000000000000001", null).anchor;
    const second = anchor("00000000000000000002", first.hash).anchor;
    const fork = anchor("00000000000000000002", first.hash).anchor;
    fork.hash = "c".repeat(64);
    fork.key = commitKey("", repositoryId, writerId, fork.sequence, fork.hash);
    const frontiers = advanceWriterFrontiers({}, [first, second, fork]);
    expect(frontiers[writerId].map((item) => item.hash)).toEqual([second.hash, fork.hash].sort());
    expect(advanceWriterFrontiers(frontiers, [first, second, fork])).toEqual(frontiers);
    expect(() => advanceWriterFrontiers({}, [{ ...second, previousCommitHash: "d".repeat(64) }])).toThrow("not continuous");
  });

  it("directly GETs and hashes every persisted tip even when List is unavailable", async () => {
    const current = anchor("00000000000000000001", null);
    let gets = 0;
    const store = { getStream: async (key: string) => { gets += 1; if (key !== current.anchor.key) throw new Error("missing"); return objectBodyFromBytes(current.bytes); } };
    await expect(verifyWriterFrontiers(store, repositoryId, descriptorHash, { [writerId]: [current.anchor] })).resolves.toBeUndefined();
    expect(gets).toBe(1);
    await expect(verifyWriterFrontiers({ getStream: async () => { throw new Error("known anchor missing after retries"); } }, repositoryId, descriptorHash, { [writerId]: [current.anchor] })).rejects.toThrow("known anchor missing");
    await expect(verifyWriterFrontiers({ getStream: async () => objectBodyFromBytes(new TextEncoder().encode("tampered")) }, repositoryId, descriptorHash, { [writerId]: [current.anchor] })).rejects.toMatchObject({ kind: "integrity" });
  });
});
