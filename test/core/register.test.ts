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

  it("does not revive a superseded version after redundant parent delivery", () => {
    const versions = [
      { ...base, versionId: "root", logicalKey: "a", parents: [] },
      { ...base, versionId: "next", logicalKey: "a", parents: ["root"] },
    ];
    expect(reduceRegister([...versions, versions[0]])).toEqual({ heads: ["next"], pending: [], invalid: [] });
  });

  it("satisfies commutative, associative, and idempotent delivery laws", () => {
    const versionArbitrary = fc.array(fc.nat(), { minLength: 1, maxLength: 24 }).map((choices) =>
      choices.map((choice, index) => ({
        ...base,
        versionId: `v${index}`,
        logicalKey: "a",
        parents: index === 0 ? [] : [`v${choice % index}`],
      })),
    );

    fc.assert(fc.property(versionArbitrary, fc.nat(), fc.nat(), (versions, firstChoice, secondChoice) => {
      const first = firstChoice % (versions.length + 1);
      const second = first + (secondChoice % (versions.length - first + 1));
      const left = versions.slice(0, first);
      const middle = versions.slice(first, second);
      const right = versions.slice(second);
      const expected = reduceRegister(versions);

      expect(reduceRegister([...middle, ...left, ...right])).toEqual(expected);
      expect(reduceRegister([...left, ...middle, ...right])).toEqual(
        reduceRegister([...left, ...[...middle, ...right]]),
      );
      expect(reduceRegister([...versions, ...versions])).toEqual(expected);
    }), { numRuns: 500, seed: 20260713 });
  });

  it("verifies a pending child when its parent arrives", () => {
    const parent = { ...base, versionId: "parent", logicalKey: "a", parents: [] };
    const child = { ...base, versionId: "child", logicalKey: "a", parents: ["parent"] };

    expect(reduceRegister([child])).toEqual({ heads: [], pending: ["child"], invalid: [] });
    expect(reduceRegister([child, parent])).toEqual({ heads: ["child"], pending: [], invalid: [] });
  });

  it("isolates self, cycle, and cross-path parents while keeping dangling parents pending", () => {
    const root = { ...base, versionId: "root", logicalKey: "a", parents: [] };
    const versions = [
      root,
      { ...base, versionId: "dangling", logicalKey: "a", parents: ["missing"] },
      { ...base, versionId: "self", logicalKey: "a", parents: ["self"] },
      { ...base, versionId: "cycle-a", logicalKey: "a", parents: ["cycle-b"] },
      { ...base, versionId: "cycle-b", logicalKey: "a", parents: ["cycle-a"] },
      { ...base, versionId: "cross-path", logicalKey: "b", parents: ["root"] },
    ];

    expect(reduceRegister(versions)).toEqual({
      heads: ["root"],
      pending: ["dangling"],
      invalid: ["cross-path", "cycle-a", "cycle-b", "self"],
    });
  });

  it("ignores timestamps, mtimes, delivery order, and cross-writer sequence metadata", () => {
    const root = { ...base, versionId: "root", logicalKey: "a", parents: [], timestamp: 999, mtime: 100, writerId: "z", sequence: "99" };
    const next = { ...base, versionId: "next", logicalKey: "a", parents: ["root"], timestamp: 1, mtime: 0, writerId: "a", sequence: "1" };
    expect(reduceRegister([next, root])).toEqual({ heads: ["next"], pending: [], invalid: [] });
  });

  it("keeps Config snapshots pending until their Tree arrives and isolates deletes without parent management", () => {
    const config = { repositoryId: "repository", channel: "config" as const, logicalKey: "portable" };
    const parent = { ...config, versionId: "parent", parents: [], configTree: { items: [{ path: "plugins/example/data.json", kind: "put" as const }] } };
    const validDelete = { ...config, versionId: "delete", parents: ["parent"], configTree: { items: [{ path: "plugins/example/data.json", kind: "delete" as const }] } };
    const invalidDelete = { ...config, versionId: "invalid", parents: ["parent"], configTree: { items: [{ path: "plugins/other/data.json", kind: "delete" as const }] } };

    expect(reduceRegister([{ ...config, versionId: "missing-tree", parents: [] }])).toEqual({ heads: [], pending: ["missing-tree"], invalid: [] });
    expect(reduceRegister([parent, validDelete])).toEqual({ heads: ["delete"], pending: [], invalid: [] });
    expect(reduceRegister([parent, invalidDelete])).toEqual({ heads: ["parent"], pending: [], invalid: ["invalid"] });
  });

  it("keeps concurrent ConfigTree snapshots as whole-tree heads", () => {
    const config = { repositoryId: "repository", channel: "config" as const, logicalKey: "portable" };
    const left = { ...config, versionId: "left", parents: [], configTree: { items: [{ path: "themes/a/theme.css", kind: "put" as const }] } };
    const right = { ...config, versionId: "right", parents: [], configTree: { items: [{ path: "snippets/b.css", kind: "put" as const }] } };

    expect(reduceRegister([right, left])).toEqual({ heads: ["left", "right"], pending: [], invalid: [] });
  });

  it("groups equivalent heads without discarding their original Version IDs", () => {
    expect(groupEquivalentHeads(["b", "a", "delete"], new Map([["a", "blob:abc"], ["b", "blob:abc"], ["delete", "delete"]]))).toEqual([
      { value: "blob:abc", representative: "a", members: ["a", "b"] },
      { value: "delete", representative: "delete", members: ["delete"] },
    ]);
  });
});
