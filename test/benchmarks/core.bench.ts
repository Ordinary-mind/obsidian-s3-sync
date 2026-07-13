import { bench, describe } from "vitest";
import { createRepositoryBenchmarkDataset } from "../../core/benchmark-dataset";

let sink = 0;

describe("large repository planning", () => {
  bench("10,000 small files", () => {
    const dataset = createRepositoryBenchmarkDataset(10_000);
    sink = dataset.files.reduce((total, file) => total + file.size, 0);
  });

  bench("100,000 small files", () => {
    const dataset = createRepositoryBenchmarkDataset(100_000);
    sink = dataset.files.reduce((total, file) => total + file.size, 0);
  }, { iterations: 5 });
});
