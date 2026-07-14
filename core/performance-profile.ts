export type PerformancePlatform = "desktop" | "mobile";

export interface RepositoryPerformanceProfile {
  platform: PerformancePlatform;
  hashConcurrency: number;
  uploadConcurrency: number;
  downloadConcurrency: number;
  streamChunkBytes: number;
  bootstrapChunkMutations: number;
  bootstrapWorkSlice: number;
  maximumMainThreadSliceMs: number;
  maximumHeapGrowthBytes: number;
}

export const repositoryPerformanceProfiles: Readonly<Record<PerformancePlatform, RepositoryPerformanceProfile>> = Object.freeze({
  desktop: Object.freeze({
    platform: "desktop",
    hashConcurrency: 4,
    uploadConcurrency: 4,
    downloadConcurrency: 4,
    streamChunkBytes: 256 * 1024,
    bootstrapChunkMutations: 512,
    bootstrapWorkSlice: 2048,
    maximumMainThreadSliceMs: 50,
    maximumHeapGrowthBytes: 256 * 1024 * 1024,
  }),
  mobile: Object.freeze({
    platform: "mobile",
    hashConcurrency: 2,
    uploadConcurrency: 2,
    downloadConcurrency: 2,
    streamChunkBytes: 128 * 1024,
    bootstrapChunkMutations: 100,
    bootstrapWorkSlice: 1024,
    maximumMainThreadSliceMs: 32,
    maximumHeapGrowthBytes: 96 * 1024 * 1024,
  }),
});

export interface PerformanceMemoryObservation {
  platform: PerformancePlatform;
  dataset: string;
  phase: "bootstrap" | "stream-hash" | "staging" | "upload" | "download";
  peakHeapBytes: number;
  baselineHeapBytes: number;
}

export function evaluateMemoryObservation(observation: PerformanceMemoryObservation): {
  heapGrowthBytes: number;
  withinBudget: boolean;
} {
  if (!Number.isSafeInteger(observation.peakHeapBytes) || !Number.isSafeInteger(observation.baselineHeapBytes)
    || observation.peakHeapBytes < 0 || observation.baselineHeapBytes < 0) {
    throw new Error("performance memory observation is invalid");
  }
  const heapGrowthBytes = Math.max(0, observation.peakHeapBytes - observation.baselineHeapBytes);
  return {
    heapGrowthBytes,
    withinBudget: heapGrowthBytes <= repositoryPerformanceProfiles[observation.platform].maximumHeapGrowthBytes,
  };
}
