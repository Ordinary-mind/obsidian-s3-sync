import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { groupEquivalentHeads, reduceRegister } from "../../core/register";

describe("core register reduction", () => {
  const base = { repositoryId: "repository", channel: "vault" as const };
  it("keeps concurrent heads and lets a verified resolution supersede them", () => {
    const root = "root";
    expect(reduceRegister([{ ...base, versionId: root, logicalKey: "a", parents: [] }, { ...base, versionId: "a", logicalKey: "a", parents: [root] }, { ...base, versionId: "b", logicalKey: "a", parents: [root] }]).heads).toEqual(["a", "b"]);
    expect(reduceRegister([{ ...base, versionId: root, logicalKey: "a", parents: [] }, { ...base, versionId: "a", logicalKey: "a", parents: [root] }, { ...base, versionId: "b", logicalKey: "a", parents: [root] }, { ...base, versionId: "r", logicalKey: "a", parents: ["a", "b"] }]).heads).toEqual(["r"]);
  });
  it("separates missing parents from invalid cross-register and cyclic links", () => {
    expect(reduceRegister([{ ...base, versionId: "p", logicalKey: "a", parents: ["missing"] }])).toEqual({ heads: [], pending: ["p"], invalid: [] });
    expect(reduceRegister([{ ...base, versionId: "p", logicalKey: "a", parents: ["missing"] }, { ...base, versionId: "child", logicalKey: "a", parents: ["p"] }]).pending).toEqual(["child", "p"]);
    expect(reduceRegister([{ ...base, versionId: "a", logicalKey: "a", parents: [] }, { ...base, versionId: "b", channel: "config", logicalKey: "a", parents: ["a"] }]).invalid).toEqual(["b"]);
    expect(reduceRegister([{ ...base, versionId: "a", logicalKey: "a", parents: ["b"] }, { ...base, versionId: "b", logicalKey: "a", parents: ["a"] }]).invalid).toEqual(["a", "b"]);
  });

  it("is invariant under 1,000 reordered and duplicate deliveries", () => {
    const versions = [
      { ...base, versionId: "root", logicalKey: "a", parents: [] },
      { ...base, versionId: "a", logicalKey: "a", parents: ["root"] },
      { ...base, versionId: "b", logicalKey: "a", parents: ["root"] },
      { ...base, versionId: "resolution", logicalKey: "a", parents: ["a", "b"] },
    ];
    const expected = reduceRegister(versions);
    fc.assert(
      fc.property(fc.shuffledSubarray(versions, { minLength: versions.length, maxLength: versions.length }), fc.array(fc.constantFrom(...versions), { maxLength: 8 }), (shuffled, duplicates) => {
        expect(reduceRegister([...shuffled, ...duplicates])).toEqual(expected);
      }),
      { numRuns: 1000, seed: 20260711 },
    );
  });

  it("groups equivalent heads without discarding their original Version IDs", () => {
    expect(groupEquivalentHeads(["b", "a", "delete"], new Map([["a", "blob:abc"], ["b", "blob:abc"], ["delete", "delete"]]))).toEqual([
      { value: "blob:abc", representative: "a", members: ["a", "b"] },
      { value: "delete", representative: "delete", members: ["delete"] },
    ]);
  });
});
