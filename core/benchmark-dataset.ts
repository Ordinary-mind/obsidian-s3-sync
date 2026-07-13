export interface BenchmarkFileRecipe {
  path: string;
  size: number;
  seed: number;
}

export interface RepositoryBenchmarkDataset {
  name: string;
  files: BenchmarkFileRecipe[];
  attachment?: BenchmarkFileRecipe;
  configRewriteCount: number;
}

export function createRepositoryBenchmarkDataset(fileCount: 10_000 | 100_000): RepositoryBenchmarkDataset {
  return {
    name: `${fileCount}-small-files`,
    files: Array.from({ length: fileCount }, (_, index) => ({
      path: `notes/${index.toString().padStart(6, "0")}.md`,
      size: 128 + index % 1024,
      seed: index,
    })),
    attachment: { path: "attachments/large.bin", size: 512 * 1024 * 1024, seed: 0x5a17 },
    configRewriteCount: 10_000,
  };
}

export async function measurePeakHeap<T>(operation: () => Promise<T>, sample: () => number): Promise<{ value: T; peakBytes: number }> {
  let peakBytes = sample();
  const timer = setInterval(() => { peakBytes = Math.max(peakBytes, sample()); }, 5);
  try {
    const value = await operation();
    peakBytes = Math.max(peakBytes, sample());
    return { value, peakBytes };
  } finally {
    clearInterval(timer);
  }
}
