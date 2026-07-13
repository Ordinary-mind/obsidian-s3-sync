import { describe, expect, it } from "vitest";
import { buildVaultPutPublishEnvelope } from "../../core/vault-publish-envelope";

describe("Vault put publish envelope", () => {
  it("freezes Blob, Change Chunk and Commit for a root put", () => {
    const envelope = buildVaultPutPublishEnvelope({ prefix: "", repositoryId: "123e4567-e89b-42d3-a456-426614174000", descriptorHash: "a".repeat(64), writerId: "123e4567-e89b-42d3-a456-426614174001", sequence: "00000000000000000001", previousCommitHash: null, createdAt: "2026-07-13T00:00:00.000Z", clientVersion: "0.1.0", path: "notes/a.md", parents: [], capture: { bytes: new Uint8Array([1]), hash: "b".repeat(64), size: 1 } });
    expect(envelope.blobs).toHaveLength(1);
    expect(envelope.chunks).toHaveLength(1);
    expect(envelope.commit.key).toContain("/commits/");
  });
});
