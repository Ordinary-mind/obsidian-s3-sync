import { describe, expect, it } from "vitest";
import { buildVaultDeleteControlEnvelope, buildVaultPutPublishEnvelope } from "../../core/vault-publish-envelope";
import { sha256Hex } from "../../protocol/hash";

describe("Vault put publish envelope", () => {
  it("freezes Blob, Change Chunk and Commit for a root put", () => {
    const bytes = new Uint8Array([1]);
    const envelope = buildVaultPutPublishEnvelope({ prefix: "", repositoryId: "123e4567-e89b-42d3-a456-426614174000", descriptorHash: "a".repeat(64), writerId: "123e4567-e89b-42d3-a456-426614174001", sequence: "00000000000000000001", previousCommitHash: null, createdAt: "2026-07-13T00:00:00.000Z", clientVersion: "0.1.0", path: "notes/a.md", parents: [], capture: { bytes, hash: sha256Hex(bytes), size: bytes.byteLength } });
    expect(envelope.blobs).toHaveLength(1);
    expect(envelope.chunks).toHaveLength(1);
    expect(envelope.commit.key).toContain("/commits/");
  });

  it("builds a delete envelope without a Blob", () => {
    const parent = `${"b".repeat(64)}:0:0`;
    const envelope = buildVaultDeleteControlEnvelope({
      prefix: "",
      repositoryId: "123e4567-e89b-42d3-a456-426614174000",
      descriptorHash: "a".repeat(64),
      writerId: "123e4567-e89b-42d3-a456-426614174001",
      sequence: "00000000000000000002",
      previousCommitHash: "c".repeat(64),
      createdAt: "2026-07-13T00:00:00.000Z",
      clientVersion: "0.1.0",
      path: "notes/a.md",
      parents: [parent],
    });
    expect(envelope.blobs).toEqual([]);
    expect(JSON.parse(new TextDecoder().decode(envelope.chunks[0].bytes)).mutations).toEqual([
      { path: "notes/a.md", kind: "delete", parents: [parent] },
    ]);
  });

  it("publishes an existing remote version from a new writer as a change", () => {
    const parent = `${"b".repeat(64)}:0:0`;
    const bytes = new Uint8Array([1]);
    const envelope = buildVaultPutPublishEnvelope({
      prefix: "",
      repositoryId: "123e4567-e89b-42d3-a456-426614174000",
      descriptorHash: "a".repeat(64),
      writerId: "123e4567-e89b-42d3-a456-426614174001",
      sequence: "00000000000000000001",
      previousCommitHash: null,
      createdAt: "2026-07-19T00:00:00.000Z",
      clientVersion: "0.1.6",
      path: "notes/a.md",
      parents: [parent],
      capture: { bytes, hash: sha256Hex(bytes), size: bytes.byteLength },
    });

    expect(JSON.parse(new TextDecoder().decode(envelope.commit.bytes))).toMatchObject({
      sequence: "00000000000000000001",
      previousCommitHash: null,
      kind: "change",
    });
  });

  it("publishes a resolved remote conflict from a new writer as a conflict resolution", () => {
    const parents = [`${"b".repeat(64)}:0:0`, `${"c".repeat(64)}:0:0`];
    const envelope = buildVaultDeleteControlEnvelope({
      prefix: "",
      repositoryId: "123e4567-e89b-42d3-a456-426614174000",
      descriptorHash: "a".repeat(64),
      writerId: "123e4567-e89b-42d3-a456-426614174001",
      sequence: "00000000000000000001",
      previousCommitHash: null,
      createdAt: "2026-07-19T00:00:00.000Z",
      clientVersion: "0.1.6",
      path: "notes/a.md",
      parents,
    });

    expect(JSON.parse(new TextDecoder().decode(envelope.commit.bytes))).toMatchObject({
      sequence: "00000000000000000001",
      previousCommitHash: null,
      kind: "conflict-resolution",
    });
  });
});
