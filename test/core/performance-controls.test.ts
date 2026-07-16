import { describe, expect, it } from "vitest";
import { BoundedExecutor } from "../../core/bounded-executor";
import { verifyBlobWithAdvisoryCache, type BlobExistenceCacheEntry } from "../../core/blob-existence-cache";
import { createRepositoryBenchmarkDataset, streamBenchmarkFile } from "../support/benchmark-dataset";
import { evaluateMemoryObservation, repositoryPerformanceProfile } from "../../core/performance-profile";
import { protocolLimits } from "../../protocol/limits";

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

  it("defines deterministic 10k/100k, attachment and high-frequency config datasets", () => {
    for (const count of [10_000, 100_000] as const) {
      const dataset = createRepositoryBenchmarkDataset(count);
      expect(dataset.files).toHaveLength(count);
      expect(new Set(dataset.files.map((file) => file.path)).size).toBe(count);
      expect(dataset.attachment?.size).toBe(512 * 1024 * 1024);
      expect(dataset.configRewriteCount).toBe(10_000);
    }
  });

  it("defines one bounded desktop stream envelope and evaluates recorded heap peaks", async () => {
    expect(repositoryPerformanceProfile).toMatchObject({ platform: "desktop", hashConcurrency: 4, uploadConcurrency: 4, downloadConcurrency: 4 });
    expect(Math.ceil(100_000 / repositoryPerformanceProfile.bootstrapChunkMutations))
      .toBeLessThanOrEqual(protocolLimits.commitChunks);
    const chunks: number[] = [];
    for await (const chunk of streamBenchmarkFile(
      { path: "attachment.bin", size: 1024 * 1024 + 7, seed: 1 },
      repositoryPerformanceProfile.streamChunkBytes,
    )) chunks.push(chunk.byteLength);
    expect(Math.max(...chunks)).toBe(repositoryPerformanceProfile.streamChunkBytes);
    expect(chunks.reduce((total, size) => total + size, 0)).toBe(1024 * 1024 + 7);
    const budget = repositoryPerformanceProfile.maximumHeapGrowthBytes;
    expect(evaluateMemoryObservation({
      dataset: "100000-small-files",
      phase: "bootstrap",
      baselineHeapBytes: 10,
      peakHeapBytes: 10 + budget,
    })).toEqual({ heapGrowthBytes: budget, withinBudget: true });
  });
});

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) { if (predicate()) return; await Promise.resolve(); }
  throw new Error("condition not reached");
}
