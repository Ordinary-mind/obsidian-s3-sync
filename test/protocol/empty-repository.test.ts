import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("empty repository protocol vector", () => {
  it("uses only format.json as the empty repository anchor", () => {
    const vector = JSON.parse(
      readFileSync(new URL("../../protocol/vectors/empty-repository.json", import.meta.url), "utf8"),
    ) as {
      expected: { commitCount: number; writerFrontiers: unknown[]; changeChunks: unknown[]; anchor: string };
      forbidden: string[];
    };
    expect(vector.expected).toEqual({
      commitCount: 0,
      writerFrontiers: [],
      changeChunks: [],
      anchor: "format.json",
    });
    expect(vector.forbidden).toContain("empty-commit");
    expect(vector.forbidden).toContain("empty-change-chunk");
  });
});
