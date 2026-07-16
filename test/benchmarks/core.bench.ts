import { afterAll, bench, describe } from "vitest";
import { createRepositoryBenchmarkDataset, measurePeakHeap, streamBenchmarkFile } from "../support/benchmark-dataset";
import { buildVaultMultiChunkEnvelopeIncremental } from "../../core/commit-builder";
import { sha256Stream } from "../../core/streaming-capture";
import { evaluateMemoryObservation, repositoryPerformanceProfile } from "../../core/performance-profile";
import { sha256Hex } from "../../protocol/hash";
import { protocolLimits } from "../../protocol/limits";

let sink = 0;
const performanceObservations = new Map<string, { peakHeapBytes?: number; heapGrowthBytes?: number; maximumWorkSliceMs?: number; maximumWorkSlicePhase?: string; chunkCount?: number }>();

afterAll(() => {
  if (performanceObservations.size > 0) console.info("performance-observations", Object.fromEntries(performanceObservations));
});

describe("large repository planning", () => {
  bench("100,000-file single-Commit bootstrap with bounded Chunks", async () => {
    const dataset = createRepositoryBenchmarkDataset(100_000);
    const profile = repositoryPerformanceProfile;
    const mutations = [...dataset.files].reverse().map((file) => ({ path: file.path, kind: "put" as const, blob: { hash: file.seed.toString(16).padStart(64, "0"), size: file.size }, parents: [] }));
    let maximumWorkSliceMs = 0;
    let maximumWorkSlicePhase = "copy";
    let sliceStartedAt = performance.now();
    const baselineHeapBytes = process.memoryUsage().heapUsed;
    const measured = await measurePeakHeap(() => buildVaultMultiChunkEnvelopeIncremental({
      prefix: "",
      repositoryId: "123e4567-e89b-42d3-a456-426614174000",
      descriptorHash: "a".repeat(64),
      writerId: "123e4567-e89b-42d3-a456-426614174001",
      sequence: "00000000000000000001",
      previousCommitHash: null,
      createdAt: "2026-07-14T00:00:00.000Z",
      kind: "bootstrap",
      clientVersion: "0.1.0",
      mutations,
    }, {
      chunkMutationLimit: profile.bootstrapChunkMutations,
      workSlice: profile.bootstrapWorkSlice,
      yieldToIdle: async (phase) => {
        const duration = performance.now() - sliceStartedAt;
        if (duration > maximumWorkSliceMs) {
          maximumWorkSliceMs = duration;
          maximumWorkSlicePhase = phase ?? "unknown";
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        sliceStartedAt = performance.now();
      },
    }), () => process.memoryUsage().heapUsed);
    const finalSliceMs = performance.now() - sliceStartedAt;
    if (finalSliceMs > maximumWorkSliceMs) {
      maximumWorkSliceMs = finalSliceMs;
      maximumWorkSlicePhase = "assemble";
    }
    const memory = evaluateMemoryObservation({
      dataset: dataset.name,
      phase: "bootstrap",
      baselineHeapBytes,
      peakHeapBytes: measured.peakBytes,
    });
    performanceObservations.set("desktop-bootstrap", {
      peakHeapBytes: measured.peakBytes,
      heapGrowthBytes: memory.heapGrowthBytes,
      maximumWorkSliceMs,
      maximumWorkSlicePhase,
      chunkCount: measured.value.chunks.length,
    });
    const expectedChunkCount = Math.ceil(dataset.files.length / profile.bootstrapChunkMutations);
    if (measured.value.chunks.length !== expectedChunkCount || measured.value.chunks.length > protocolLimits.commitChunks) {
      throw new Error(`desktop bootstrap emitted ${measured.value.chunks.length} Change Chunks`);
    }
    if (measured.value.chunks.some((chunk) => chunk.bytes.byteLength > protocolLimits.changeChunkBytes)) {
      throw new Error("desktop bootstrap emitted an oversized Change Chunk");
    }
    if (!memory.withinBudget) throw new Error(`desktop bootstrap heap growth ${memory.heapGrowthBytes} exceeded its budget`);
    if (maximumWorkSliceMs > profile.maximumMainThreadSliceMs) {
      throw new Error(`desktop bootstrap ${maximumWorkSlicePhase} slice ${maximumWorkSliceMs.toFixed(1)} ms exceeded its budget`);
    }
    sink = measured.value.chunks.length;
  }, { iterations: 1, warmupIterations: 0, warmupTime: 0, time: 0 });

  bench("512 MiB attachment stream Hash (desktop envelope)", async () => {
    const dataset = createRepositoryBenchmarkDataset(10_000);
    const baselineHeapBytes = process.memoryUsage().heapUsed;
    const measured = await measurePeakHeap(
      () => sha256Stream(streamBenchmarkFile(dataset.attachment!, repositoryPerformanceProfile.streamChunkBytes)),
      () => process.memoryUsage().heapUsed,
    );
    const memory = evaluateMemoryObservation({
      dataset: dataset.attachment!.path,
      phase: "stream-hash",
      baselineHeapBytes,
      peakHeapBytes: measured.peakBytes,
    });
    if (!memory.withinBudget) throw new Error("desktop attachment Hash exceeded its heap-growth budget");
    performanceObservations.set("desktop-attachment", { peakHeapBytes: measured.peakBytes, heapGrowthBytes: memory.heapGrowthBytes });
    sink = memory.heapGrowthBytes + measured.value.size;
  }, { iterations: 1, warmupIterations: 0, warmupTime: 0, time: 0 });

  bench("10,000 small files", () => {
    const dataset = createRepositoryBenchmarkDataset(10_000);
    sink = dataset.files.reduce((total, file) => total + file.size, 0);
  });

  bench("100,000 small files", () => {
    const dataset = createRepositoryBenchmarkDataset(100_000);
    sink = dataset.files.reduce((total, file) => total + file.size, 0);
  }, { iterations: 5 });

  bench("10,000 high-frequency config rewrites", () => {
    const dataset = createRepositoryBenchmarkDataset(10_000);
    for (let index = 0; index < dataset.configRewriteCount; index += 1) {
      sink ^= Number.parseInt(sha256Hex(new TextEncoder().encode(`plugins/example/data.json:${index}`)).slice(0, 8), 16);
    }
  });
});
