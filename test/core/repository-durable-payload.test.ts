import { describe, expect, it } from "vitest";
import { createRepositoryLocator, repositoryFingerprint } from "../../core/locator";
import { parseRepositoryDurablePayload, repositoryDurablePayload } from "../../core/repository-durable-payload";

describe("repository durable payload", () => {
  it("round-trips identity, writer sequence, and branch tips and rejects identity changes", () => {
    const locator = createRepositoryLocator({ endpoint: "https://s3.example.com", region: "test", bucket: "vault", forcePathStyle: true, prefix: "team" });
    const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
    const descriptorHash = "a".repeat(64);
    const writerId = "123e4567-e89b-42d3-a456-426614174001";
    const hash = "b".repeat(64);
    const payload = repositoryDurablePayload({ repositoryId, descriptorHash, repositoryFingerprint: repositoryFingerprint(locator, repositoryId, descriptorHash), locator, configDir: ".obsidian", historicalConfigDirs: [], writerId, nextSequence: "00000000000000000002", previousCommitHash: hash, writerFrontiers: { [writerId]: [{ key: `commit-${hash}`, writerId, sequence: "00000000000000000001", hash, previousCommitHash: null }] } });
    expect(parseRepositoryDurablePayload(payload)).toMatchObject({ repositoryId, writerId, nextSequence: "00000000000000000002", previousCommitHash: hash });
    expect(() => parseRepositoryDurablePayload({ ...(payload as Record<string, any>), descriptorHash: "c".repeat(64) })).toThrow("fingerprint");
  });
});
