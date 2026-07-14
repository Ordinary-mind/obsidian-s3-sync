import { describe, expect, it } from "vitest";
import { resolveVaultBlobDependencies, verifyVaultBlobDependencies } from "../../core/remote-dependencies";

describe("remote Vault Blob dependencies", () => {
  it("blocks only the damaged register and never substitutes empty bytes", async () => {
    const dependencies = [
      { path: "notes/good.md", hash: "a".repeat(64), size: 1, heads: ["good"] },
      { path: "notes/missing.md", hash: "b".repeat(64), size: 2, heads: ["missing"] },
      { path: "notes/wrong-size.md", hash: "c".repeat(64), size: 3, heads: ["wrong"] },
    ];
    const result = await resolveVaultBlobDependencies(dependencies, async (dependency) => {
      if (dependency.path === "notes/missing.md") throw new Error("not found");
      return dependency.path === "notes/good.md" ? new Uint8Array([1]) : new Uint8Array();
    });
    expect(result.available).toEqual([expect.objectContaining({ path: "notes/good.md", bytes: new Uint8Array([1]) })]);
    expect(result.blocked.map((item) => item.path)).toEqual(["notes/missing.md", "notes/wrong-size.md"]);
  });

  it("uses a bounded worker pool, yields between slices, and preserves input order", async () => {
    const dependencies = Array.from({ length: 8 }, (_, index) => ({
      path: `notes/${index}.md`,
      hash: index.toString(16).padStart(64, "0"),
      size: index,
      heads: [`head-${index}`],
    }));
    let active = 0;
    let peak = 0;
    let yields = 0;
    const result = await verifyVaultBlobDependencies(dependencies, async (dependency) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      active -= 1;
      if (dependency.path === "notes/3.md") throw new Error("damaged");
    }, {
      concurrency: 2,
      yieldEvery: 3,
      yieldToIdle: async () => { yields += 1; },
    });
    expect(peak).toBe(2);
    expect(yields).toBe(2);
    expect(result.available.map((item) => item.path)).toEqual([
      "notes/0.md", "notes/1.md", "notes/2.md", "notes/4.md", "notes/5.md", "notes/6.md", "notes/7.md",
    ]);
    expect(result.blocked.map((item) => item.path)).toEqual(["notes/3.md"]);
  });
});
