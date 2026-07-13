import { describe, expect, it, vi } from "vitest";
import { createRepositoryLocator, repositoryFingerprint } from "../../core/locator";
import {
  applyCredentialRotation,
  applyVerifiedRepositoryRouteChange,
  classifyRepositoryReconfigure,
  type RepositoryRuntimeBinding,
} from "../../core/repository-reconfigure";

describe("repository reconfiguration", () => {
  const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
  const descriptorHash = "a".repeat(64);
  const writerId = "123e4567-e89b-42d3-a456-426614174001";
  const hash = "b".repeat(64);
  const locator = createRepositoryLocator({ endpoint: "https://one.example.com", region: "one", bucket: "vault", forcePathStyle: true, prefix: "team" });
  const current: RepositoryRuntimeBinding = {
    repositoryId,
    descriptorHash,
    repositoryFingerprint: repositoryFingerprint(locator, repositoryId, descriptorHash),
    locator,
    writerFrontiers: { [writerId]: [{ key: "commit", writerId, sequence: "00000000000000000001", hash, previousCommitHash: null }] },
  };

  it("requires reattachment for Bucket or Prefix changes", () => {
    const candidate = createRepositoryLocator({ ...locator, bucket: "other", prefix: "team" });
    expect(classifyRepositoryReconfigure({ current, candidate: { repositoryId, descriptorHash, locator: candidate } })).toBe("reattach-required");
  });

  it("stops scheduling, verifies descriptor and every anchor, then atomically changes a route", async () => {
    const candidateLocator = createRepositoryLocator({ ...locator, endpoint: "https://two.example.com", region: "two", prefix: "team" });
    const calls: string[] = [];
    const updated = await applyVerifiedRepositoryRouteChange({
      current,
      candidateLocator,
      coordinator: { stopAndFlush: async () => { calls.push("stop"); } },
      verifier: {
        verifyDescriptor: async () => { calls.push("descriptor"); },
        verifyCommitAnchor: async () => { calls.push("anchor"); },
      },
      persistAtomically: async () => { calls.push("persist"); },
    });
    expect(calls).toEqual(["stop", "descriptor", "anchor", "persist"]);
    expect(updated.repositoryFingerprint).toBe(repositoryFingerprint(candidateLocator, repositoryId, descriptorHash));
  });

  it("rotates credentials without rebuilding causal state", async () => {
    const persist = vi.fn(async () => undefined);
    const result = await applyCredentialRotation({
      currentBinding: current,
      credentials: { token: "new" },
      coordinator: { stopAndFlush: async () => undefined },
      verifyCredentials: async () => undefined,
      persistCredentials: persist,
    });
    expect(result).toBe(current);
    expect(persist).toHaveBeenCalledWith({ token: "new" });
  });
});
