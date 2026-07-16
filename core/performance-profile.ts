export interface RepositoryPerformanceProfile {
  platform: "desktop";
  hashConcurrency: number;
  uploadConcurrency: number;
  downloadConcurrency: number;
  streamChunkBytes: number;
  bootstrapChunkMutations: number;
  bootstrapWorkSlice: number;
  maximumMainThreadSliceMs: number;
  maximumHeapGrowthBytes: number;
}

export const repositoryPerformanceProfile: Readonly<RepositoryPerformanceProfile> = Object.freeze({
  platform: "desktop",
  hashConcurrency: 4,
  uploadConcurrency: 4,
  downloadConcurrency: 4,
  streamChunkBytes: 256 * 1024,
  bootstrapChunkMutations: 512,
  bootstrapWorkSlice: 2048,
  maximumMainThreadSliceMs: 50,
  maximumHeapGrowthBytes: 256 * 1024 * 1024,
});

export interface PerformanceMemoryObservation {
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
    withinBudget: heapGrowthBytes <= repositoryPerformanceProfile.maximumHeapGrowthBytes,
  };
}
