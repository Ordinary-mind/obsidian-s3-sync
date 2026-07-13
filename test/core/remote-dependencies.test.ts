import { describe, expect, it } from "vitest";
import { resolveVaultBlobDependencies } from "../../core/remote-dependencies";

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
});
