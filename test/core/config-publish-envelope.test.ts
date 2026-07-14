import { describe, expect, it } from "vitest";
import { buildConfigSnapshotPublishEnvelope } from "../../core/config-publish-envelope";
import { createDefaultConfigProfile } from "../../core/config-profile";
import type { ProtocolConfigTree } from "../../core/config-tree";
import { sha256Hex } from "../../protocol/hash";

describe("Config snapshot publish envelope", () => {
  const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
  const descriptorHash = "a".repeat(64);
  const writerId = "123e4567-e89b-42d3-a456-426614174001";
  const bytes = new TextEncoder().encode("settings");
  const tree: ProtocolConfigTree = {
    protocol: 1,
    repositoryId,
    descriptorHash,
    profile: { schema: 1, ...createDefaultConfigProfile("1.8.0"), minimumTargetAppVersion: "1.8.0" },
    enabledCommunityPlugins: [],
    items: [{ path: "app.json", kind: "put", blobHash: sha256Hex(bytes), size: bytes.byteLength }],
  };

  it("freezes every dependency and derives the Config version from the Commit", () => {
    const built = buildConfigSnapshotPublishEnvelope({
      prefix: "team",
      repositoryId,
      descriptorHash,
      writerId,
      sequence: "00000000000000000001",
      previousCommitHash: null,
      createdAt: "2026-07-14T00:00:00.000Z",
      clientVersion: "0.1.0",
      parents: [`${"c".repeat(64)}:0:0`, `${"b".repeat(64)}:0:0`, `${"c".repeat(64)}:0:0`],
      tree,
      bytesByPath: new Map([["app.json", bytes]]),
      binding: { configDir: ".obsidian", historicalConfigDirs: [] },
    });
    expect(built.parents).toEqual([`${"b".repeat(64)}:0:0`, `${"c".repeat(64)}:0:0`]);
    expect(built.envelope.blobs).toHaveLength(1);
    expect(built.envelope.configTrees).toHaveLength(1);
    expect(built.envelope.chunks).toHaveLength(1);
    expect(built.versionId).toBe(`${built.envelope.commit.hash}:0:0`);
    expect(built.treeHash).toBe(built.envelope.configTrees[0].hash);
  });

  it("rejects candidate bytes that no longer match their frozen Blob reference", () => {
    expect(() => buildConfigSnapshotPublishEnvelope({
      prefix: "",
      repositoryId,
      descriptorHash,
      writerId,
      sequence: "00000000000000000001",
      previousCommitHash: null,
      createdAt: "2026-07-14T00:00:00.000Z",
      clientVersion: "0.1.0",
      parents: [],
      tree,
      bytesByPath: new Map([["app.json", new TextEncoder().encode("changed")]]),
      binding: { configDir: ".obsidian", historicalConfigDirs: [] },
    })).toThrow("Blob capture");
  });
});
