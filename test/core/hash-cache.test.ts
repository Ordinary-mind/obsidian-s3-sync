import { describe, expect, it } from "vitest";
import { resolveImmutableStagedHash } from "../../core/hash-cache";

describe("immutable staged Hash cache", () => {
  it("uses a cache only for the exact immutable staged reference", async () => {
    let computes = 0;
    const compute = async () => { computes += 1; return { hash: "verified", size: 1 }; };
    const first = await resolveImmutableStagedHash({ mode: "incremental", stagedRef: "stage-1", compute });
    const hit = await resolveImmutableStagedHash({ mode: "incremental", stagedRef: "stage-1", cacheEntry: first.cacheEntry, compute });
    const invalidated = await resolveImmutableStagedHash({ mode: "incremental", stagedRef: "stage-2", cacheEntry: first.cacheEntry, compute });
    expect(hit).toMatchObject({ value: { hash: "verified", size: 1 }, cacheHit: true });
    expect(invalidated).toMatchObject({ value: { hash: "verified", size: 1 }, cacheHit: false });
    expect(computes).toBe(2);
  });

  it("always bypasses cache hints during a full audit", async () => {
    const result = await resolveImmutableStagedHash({
      mode: "full-audit",
      stagedRef: "stage-1",
      cacheEntry: { stagedRef: "stage-1", hash: "stale", size: 99 },
      compute: async () => ({ hash: "actual", size: 2 }),
    });
    expect(result).toEqual({
      value: { hash: "actual", size: 2 },
      cacheEntry: { stagedRef: "stage-1", hash: "actual", size: 2 },
      cacheHit: false,
    });
  });
});
