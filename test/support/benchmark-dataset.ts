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

export async function* streamBenchmarkFile(
  recipe: BenchmarkFileRecipe,
  chunkBytes: number,
): AsyncIterable<Uint8Array> {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new Error("benchmark chunk size is invalid");
  const chunk = new Uint8Array(Math.min(chunkBytes, recipe.size));
  for (let index = 0; index < chunk.length; index += 1) chunk[index] = (recipe.seed + index * 31) & 0xff;
  let remaining = recipe.size;
  while (remaining > 0) {
    const size = Math.min(remaining, chunk.byteLength);
    yield size === chunk.byteLength ? chunk : chunk.subarray(0, size);
    remaining -= size;
    await Promise.resolve();
  }
}
