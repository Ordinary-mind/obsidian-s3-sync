import { describe, expect, it } from "vitest";
import { BoundedExecutor } from "../../core/bounded-executor";
import { runIncrementalAudit } from "../../core/incremental-audit";
import { verifyBlobWithAdvisoryCache, type BlobExistenceCacheEntry } from "../../core/blob-existence-cache";
import {
  checkpointHistoryPolicy,
  checkpointMatchesStateRoot,
  correctnessNeutralRemoteCaches,
  createRepositoryCheckpoint,
  verifyCheckpointBeforeUse,
} from "../../core/checkpoint";
import { createRepositoryBenchmarkDataset, streamBenchmarkFile } from "../../core/benchmark-dataset";
import { evaluateMemoryObservation, repositoryPerformanceProfiles } from "../../core/performance-profile";
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

  it("binds checkpoint state roots to normalized registers and writer frontiers", () => {
    const root = {
      schemaVersion: 1 as const,
      repositoryId: "123e4567-e89b-42d3-a456-426614174000",
      descriptorHash: "a".repeat(64),
      writerFrontiers: {},
      registers: [{
        key: "vault:notes/a.md",
        heads: ["head-b", "head-a"],
        pending: [],
        invalid: [],
        valueHash: "b".repeat(64),
      }],
    };
    const checkpoint = createRepositoryCheckpoint(root, 1);
    expect(checkpointMatchesStateRoot(checkpoint, {
      ...root,
      registers: [{ ...root.registers[0], heads: ["head-a", "head-b"] }],
    })).toBe(true);
    expect(checkpointMatchesStateRoot(checkpoint, {
      ...root,
      registers: [{ ...root.registers[0], valueHash: "c".repeat(64) }],
    })).toBe(false);
    expect(checkpointHistoryPolicy).toEqual({
      newClient: "full-history",
      verificationFailure: "full-history",
      verifiedCheckpoint: "checkpoint-and-verified-frontiers",
    });
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

  it("defines bounded desktop/mobile stream envelopes and evaluates recorded heap peaks", async () => {
    expect(repositoryPerformanceProfiles.desktop).toMatchObject({ hashConcurrency: 4, uploadConcurrency: 4, downloadConcurrency: 4 });
    expect(repositoryPerformanceProfiles.mobile).toMatchObject({ hashConcurrency: 2, uploadConcurrency: 2, downloadConcurrency: 2 });
    expect(repositoryPerformanceProfiles.mobile.bootstrapWorkSlice).toBeLessThan(repositoryPerformanceProfiles.desktop.bootstrapWorkSlice);
    expect(Math.ceil(100_000 / repositoryPerformanceProfiles.mobile.bootstrapChunkMutations))
      .toBeLessThanOrEqual(protocolLimits.commitChunks);
    const chunks: number[] = [];
    for await (const chunk of streamBenchmarkFile(
      { path: "attachment.bin", size: 1024 * 1024 + 7, seed: 1 },
      repositoryPerformanceProfiles.mobile.streamChunkBytes,
    )) chunks.push(chunk.byteLength);
    expect(Math.max(...chunks)).toBe(repositoryPerformanceProfiles.mobile.streamChunkBytes);
    expect(chunks.reduce((total, size) => total + size, 0)).toBe(1024 * 1024 + 7);
    const budget = repositoryPerformanceProfiles.mobile.maximumHeapGrowthBytes;
    expect(evaluateMemoryObservation({
      platform: "mobile",
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
