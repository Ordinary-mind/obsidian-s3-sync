import { describe, expect, it } from "vitest";
import { BoundedExecutor } from "../../core/bounded-executor";
import { runIncrementalAudit } from "../../core/incremental-audit";
import { verifyBlobWithAdvisoryCache, type BlobExistenceCacheEntry } from "../../core/blob-existence-cache";
import { correctnessNeutralRemoteCaches, verifyCheckpointBeforeUse } from "../../core/checkpoint";
import { createRepositoryBenchmarkDataset } from "../../core/benchmark-dataset";

describe("performance controls preserve correctness", () => {
  it("bounds concurrent work and records its peak", async () => {
    const executor = new BoundedExecutor(3);
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const jobs = Array.from({ length: 12 }, () => executor.run(async () => {
      active += 1; peak = Math.max(peak, active); await gate; active -= 1;
    }));
    await eventually(() => executor.metrics().active === 3 && executor.metrics().queued === 9);
    release();
    await Promise.all(jobs);
    expect(peak).toBe(3);
    expect(executor.metrics()).toMatchObject({ active: 0, queued: 0, peakActive: 3, completed: 12 });
  });

  it("slices complete audits and never authorizes deletion evidence after cancellation or failure", async () => {
    let yields = 0;
    const complete = await runIncrementalAudit({ items: [1, 2, 3, 4, 5], verify: async () => undefined, signal: new AbortController().signal, sliceSize: 2, yieldToIdle: async () => { yields += 1; } });
    expect(complete).toMatchObject({ status: "complete", completed: 5, deletionEvidenceAllowed: true });
    expect(yields).toBe(2);

    const controller = new AbortController();
    const cancelled = await runIncrementalAudit({ items: [1, 2, 3], verify: async (item) => { if (item === 1) controller.abort(); }, signal: controller.signal, yieldToIdle: async () => undefined });
    expect(cancelled).toMatchObject({ status: "cancelled", deletionEvidenceAllowed: false });
    const failed = await runIncrementalAudit({ items: [1], verify: async () => { throw new Error("bad"); }, signal: new AbortController().signal, yieldToIdle: async () => undefined });
    expect(failed).toMatchObject({ status: "complete", failures: 1, deletionEvidenceAllowed: false });
  });

  it("treats Blob cache hits as advisory and falls back to immutable publish plus GET/Hash", async () => {
    const values = new Map<string, BlobExistenceCacheEntry>([["a", { hash: "a", size: 1, verifiedAt: 0 }]]);
    let present = false;
    let verifications = 0;
    const result = await verifyBlobWithAdvisoryCache({
      hash: "a", size: 1, now: 2,
      cache: { get: async (hash) => values.get(hash), set: async (entry) => { values.set(entry.hash, entry); }, delete: async (hash) => { values.delete(hash); } },
      verifyRemote: async () => { verifications += 1; return present; },
      publishImmutable: async () => { present = true; },
    });
    expect(result).toBe("published");
    expect(verifications).toBe(2);
  });

  it("uses checkpoints only after descriptor, frontier and state verification", async () => {
    const checkpoint = { schemaVersion: 1 as const, repositoryId: "repo", descriptorHash: "a".repeat(64), writerFrontiers: {}, stateHash: "b".repeat(64), createdAt: 1 };
    await expect(verifyCheckpointBeforeUse(checkpoint, { verifyDescriptor: async () => undefined, verifyWriterFrontiers: async () => undefined, verifyStateHash: async () => true })).resolves.toBe("usable");
    await expect(verifyCheckpointBeforeUse(checkpoint, { verifyDescriptor: async () => undefined, verifyWriterFrontiers: async () => { throw new Error("missing"); }, verifyStateHash: async () => true })).resolves.toBe("full-history-required");
    expect(correctnessNeutralRemoteCaches).toEqual(["checkpoint", "latest", "device-head"]);
  });

  it("defines deterministic 10k/100k, attachment and high-frequency config datasets", () => {
    for (const count of [10_000, 100_000] as const) {
      const dataset = createRepositoryBenchmarkDataset(count);
      expect(dataset.files).toHaveLength(count);
      expect(new Set(dataset.files.map((file) => file.path)).size).toBe(count);
      expect(dataset.attachment?.size).toBe(512 * 1024 * 1024);
      expect(dataset.configRewriteCount).toBe(10_000);
    }
  });
});

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) { if (predicate()) return; await Promise.resolve(); }
  throw new Error("condition not reached");
}
