import { describe, expect, it } from "vitest";
import { captureStableConfigScan, type ConfigScanObservation } from "../../core/config-scan";
import { canApplyConfigBatch } from "../../core/config-apply";

describe("stable Config channel scans", () => {
  it("accepts only two equal complete scans and keeps second-scan staging", async () => {
    const scans: ConfigScanObservation[] = [
      { status: "complete", scopeRevision: "scope-1", items: [{ path: "app.json", hash: "same", size: 1, stagedRef: "first" }] },
      { status: "complete", scopeRevision: "scope-1", items: [{ path: "app.json", hash: "same", size: 1, stagedRef: "second" }] },
    ];
    await expect(captureStableConfigScan({ scan: async () => scans.shift()!, quietWindow: async () => {} })).resolves.toEqual({
      status: "captured",
      scopeRevision: "scope-1",
      items: [{ path: "app.json", hash: "same", size: 1, stagedRef: "second" }],
    });
  });

  it("retries unknown, scope changes, and content changes", async () => {
    await expect(captureStableConfigScan({ scan: async () => ({ status: "unknown", reason: "cancelled" }), quietWindow: async () => {} }))
      .resolves.toEqual({ status: "retry", reason: "unknown" });
    for (const scans of [
      [complete("scope-1", "a"), complete("scope-2", "a")],
      [complete("scope-1", "a"), complete("scope-1", "b")],
    ]) {
      await expect(captureStableConfigScan({ scan: async () => scans.shift()!, quietWindow: async () => {} })).resolves.toMatchObject({ status: "retry" });
    }
    await expect(captureStableConfigScan({ scan: async () => { throw new Error("read failed"); }, quietWindow: async () => {} }))
      .resolves.toEqual({ status: "retry", reason: "unknown" });
    await expect(captureStableConfigScan({ scan: async () => complete("scope", "a"), quietWindow: async () => { throw new Error("cancelled"); } }))
      .resolves.toEqual({ status: "retry", reason: "unknown" });
  });

  it("rechecks local Tree, observed heads, and RepositoryLocator before apply", () => {
    const base = { projectedTreeHash: "tree", currentTreeHash: "tree", targetHeads: ["head"], observedHeads: ["head"] };
    expect(canApplyConfigBatch({ ...base, repositoryLocatorMatches: true })).toBe(true);
    expect(canApplyConfigBatch({ ...base, currentTreeHash: "changed" })).toBe(false);
    expect(canApplyConfigBatch({ ...base, observedHeads: ["new-head"] })).toBe(false);
    expect(canApplyConfigBatch({ ...base, repositoryLocatorMatches: false })).toBe(false);
  });
});

function complete(scopeRevision: string, hash: string): ConfigScanObservation {
  return { status: "complete", scopeRevision, items: [{ path: "app.json", hash, size: 1, stagedRef: hash }] };
}
