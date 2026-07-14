import { describe, expect, it } from "vitest";
import { buildMergedConfigItems, diffManagedConfigItems, freezeConfigMergePublication, planConfigParentReduction } from "../../core/config-diff";
import { createDefaultConfigProfile } from "../../core/config-profile";

describe("ConfigTree diff and merge", () => {
  it("distinguishes delete from stop-managing and flags code/data risk", () => {
    const before = [
      { path: "plugins/p/main.js", kind: "put" as const, hash: "a", size: 1, stagedRef: "a" },
      { path: "plugins/p/unchanged.js", kind: "put" as const, hash: "same", size: 1, stagedRef: "old" },
      { path: "plugins/p/data.json", kind: "put" as const, hash: "b", size: 1, stagedRef: "b" },
      { path: "old.json", kind: "put" as const, hash: "c", size: 1, stagedRef: "c" },
    ];
    const after = [
      { path: "plugins/p/main.js", kind: "put" as const, hash: "d", size: 1, stagedRef: "d" },
      { path: "plugins/p/unchanged.js", kind: "put" as const, hash: "same", size: 1, stagedRef: "new-stage" },
      { path: "plugins/p/data.json", kind: "delete" as const },
    ];
    expect(diffManagedConfigItems(before, after)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "plugins/p/main.js", kind: "modify", codeChange: true }),
      expect.objectContaining({ path: "plugins/p/data.json", kind: "delete", sensitive: true }),
      expect.objectContaining({ path: "plugins/p/unchanged.js", kind: "unchanged", codeChange: false }),
      expect.objectContaining({ path: "old.json", kind: "stop-managing" }),
    ]));
  });

  it("requires per-path selections and freezes all operation-time heads", () => {
    const left = [{ path: "a", kind: "put" as const, hash: "a", size: 1, stagedRef: "a" }];
    const right = [{ path: "a", kind: "delete" as const }, { path: "b", kind: "put" as const, hash: "b", size: 1, stagedRef: "b" }];
    expect(() => buildMergedConfigItems({ left, right, selections: { a: "left" } })).toThrow("b");
    const items = buildMergedConfigItems({ left, right, selections: { a: "left", b: "right" } });
    expect(freezeConfigMergePublication({ profile: createDefaultConfigProfile("1.8.0"), enabledCommunityPlugins: [], items, observedHeads: ["two", "one"] }).parents).toEqual(["one", "two"]);
  });

  it("requires the ConfigTree parent-reduction chain above the protocol parent limit", () => {
    const version = (index: number) => `${index.toString(16).padStart(64, "0")}:0:0`;
    const heads = Array.from({ length: 1025 }, (_, index) => ({
      versionId: version(index),
      treeHash: (index % 2 === 0 ? "a" : "b").repeat(64),
    }));
    expect(planConfigParentReduction({ heads, createOutputVersionId: (step) => version(10_000 + step) }))
      .toMatchObject({ status: "confirmation-required" });
    const ready = planConfigParentReduction({
      heads,
      selectedTreeHash: "c".repeat(64),
      conflictSelectionConfirmed: true,
      createOutputVersionId: (step) => version(10_000 + step),
    });
    expect(ready).toMatchObject({ status: "ready", selectedTreeHash: "c".repeat(64), steps: [expect.objectContaining({ parents: expect.any(Array) })] });
    if (ready.status !== "ready") throw new Error("expected ConfigTree reduction plan");
    expect(ready.finalParents.length).toBeLessThanOrEqual(1024);
    expect(() => freezeConfigMergePublication({
      profile: createDefaultConfigProfile("1.8.0"),
      enabledCommunityPlugins: [],
      items: [],
      observedHeads: heads.map((head) => head.versionId),
    })).toThrow("parent reduction");
  });
});
