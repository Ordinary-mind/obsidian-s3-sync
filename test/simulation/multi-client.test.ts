import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { DeterministicSyncSimulator } from "../../core/deterministic-simulator";

const put = (hash: string) => ({ kind: "put" as const, hash, size: 1 });

describe("deterministic multi-client simulator", () => {
  it("keeps an editor baseline frozen while a later remote root arrives", () => {
    const sim = clients("a", "b");
    sim.edit("a", "note.md", put("local"));
    expect(sim.dirtyBasis("a", "vault", "note.md")).toEqual([]);
    sim.edit("b", "note.md", put("remote"));
    sim.freeze("b", "vault", "note.md"); sim.publishNext("b");
    sim.pull("a");
    expect(sim.dirtyBasis("a", "vault", "note.md")).toEqual([]);
    sim.freeze("a", "vault", "note.md"); sim.publishNext("a");
    sim.pull("a"); sim.pull("b");
    expect(sim.registerHeads("a", "vault", "note.md")).toHaveLength(2);
    expect(sim.registerHeads("b", "vault", "note.md")).toEqual(sim.registerHeads("a", "vault", "note.md"));
  });

  it("converges independent offline edits after both devices reconnect", () => {
    const sim = clients("a", "b");
    sim.edit("a", "a.md", put("from-a"));
    sim.freeze("a", "vault", "a.md");
    sim.publishNext("a");
    sim.edit("b", "b.md", put("from-b"));
    sim.freeze("b", "vault", "b.md");
    sim.publishNext("b");
    sim.pull("a", { order: "reverse", duplicate: 2 });
    sim.pull("b", { order: "forward", duplicate: 2 });
    expect(sim.registerHeads("a", "vault", "a.md")).toEqual(sim.registerHeads("b", "vault", "a.md"));
    expect(sim.registerHeads("a", "vault", "b.md")).toEqual(sim.registerHeads("b", "vault", "b.md"));
    expect(sim.conflicts("a")).toEqual([]);
    expect(sim.conflicts("b")).toEqual([]);
  });

  it("preserves rename versus modify as a delete conflict plus an independent new path", () => {
    const sim = clients("a", "b", "c");
    sim.edit("a", "old.md", put("base"));
    sim.freeze("a", "vault", "old.md");
    sim.publishNext("a");
    for (const client of ["a", "b", "c"]) sim.pull(client);

    sim.rename("a", "old.md", "new.md", put("base"));
    sim.freeze("a", "vault", "old.md");
    sim.publishNext("a");
    sim.freeze("a", "vault", "new.md");
    sim.publishNext("a");
    sim.edit("b", "old.md", put("modified"));
    sim.freeze("b", "vault", "old.md");
    sim.publishNext("b");

    for (const client of ["a", "b", "c"]) sim.pull(client, { order: "reverse", duplicate: 3 });
    expect(sim.registerHeads("c", "vault", "old.md")).toHaveLength(2);
    expect(sim.registerHeads("c", "vault", "new.md")).toHaveLength(1);
    expect(sim.conflicts("c")).toContain("vault:old.md");
  });

  it("replays frozen bytes across restart and links the next generation only to its exact local predecessor", () => {
    const sim = clients("a");
    sim.edit("a", "note.md", put("first"));
    const first = sim.freeze("a", "vault", "note.md");
    sim.edit("a", "note.md", put("second"));
    const snapshot = sim.snapshotClient("a");
    sim.restoreClient(snapshot);
    expect(sim.publishNext("a")?.commitHash).toBe(first.commitHash);
    const second = sim.freeze("a", "vault", "note.md");
    expect(second.parents).toEqual([first.versionId]);
    sim.publishNext("a");
    sim.assertInvariants();
  });

  it("publishes a new root put before allowing its waiting delete", () => {
    const sim = clients("a");
    sim.edit("a", "new.md", put("root"));
    const root = sim.freeze("a", "vault", "new.md");
    sim.edit("a", "new.md", { kind: "delete" });
    expect(() => sim.freeze("a", "vault", "new.md")).toThrow("root put");
    sim.publishNext("a");
    const deletion = sim.freeze("a", "vault", "new.md");
    expect(deletion.parents).toEqual([root.versionId]);
    sim.publishNext("a");
    sim.pull("a");
    expect(sim.registerHeads("a", "vault", "new.md")).toEqual([deletion.versionId]);
  });

  it("converges under reverse/duplicate/partial delivery and exposes missing-parent pending", () => {
    const sim = clients("a", "b", "c");
    sim.edit("a", "a.md", put("one")); const root = sim.freeze("a", "vault", "a.md"); sim.publishNext("a");
    sim.edit("a", "a.md", put("two")); const child = sim.freeze("a", "vault", "a.md"); sim.publishNext("a");
    sim.pull("b", { visibleVersionIds: new Set([child.versionId]), duplicate: 3 });
    expect(sim.pendingApply("b")).toEqual(["vault:a.md"]);
    sim.pull("b", { order: "reverse", duplicate: 4 });
    sim.pull("c", { order: "hash", duplicate: 2 });
    expect(sim.registerHeads("b", "vault", "a.md")).toEqual([child.versionId]);
    expect(sim.registerHeads("c", "vault", "a.md")).toEqual([child.versionId]);
    expect(root.versionId).not.toBe(child.versionId);
  });

  it("preserves modify/delete conflicts and simultaneous conflicting resolutions", () => {
    const sim = clients("a", "b", "c");
    sim.edit("a", "a.md", put("base")); sim.freeze("a", "vault", "a.md"); sim.publishNext("a");
    for (const client of ["a", "b", "c"]) sim.pull(client);
    sim.edit("a", "a.md", put("modified")); sim.freeze("a", "vault", "a.md"); sim.publishNext("a");
    sim.edit("b", "a.md", { kind: "delete" }); sim.freeze("b", "vault", "a.md"); sim.publishNext("b");
    for (const client of ["a", "b", "c"]) sim.pull(client, { order: client === "b" ? "reverse" : "forward", duplicate: 2 });
    expect(sim.conflicts("c")).toEqual(["vault:a.md"]);
    sim.resolve("a", "vault", "a.md", put("resolution-a")); sim.publishNext("a");
    sim.resolve("b", "vault", "a.md", put("resolution-b")); sim.publishNext("b");
    for (const client of ["a", "b", "c"]) sim.pull(client);
    expect(sim.registerHeads("c", "vault", "a.md")).toHaveLength(2);
  });

  it("keeps concurrent ConfigTrees as whole-snapshot heads visible to a third client", () => {
    const sim = clients("a", "b", "c");
    sim.edit("a", "portable", put("tree-a"), "config"); sim.freeze("a", "config", "portable"); sim.publishNext("a");
    sim.edit("b", "portable", put("tree-b"), "config"); sim.freeze("b", "config", "portable"); sim.publishNext("b");
    sim.pull("c", { order: "reverse", duplicate: 3 });
    expect(sim.registerHeads("c", "config", "portable")).toHaveLength(2);
    expect(sim.conflicts("c")).toEqual(["config:portable"]);
  });

  it("randomized clients converge without losing published reachability", () => {
    fc.assert(fc.property(
      fc.array(fc.record({ client: fc.constantFrom("a", "b", "c"), path: fc.integer({ min: 0, max: 4 }), value: fc.integer({ min: 0, max: 1_000_000 }) }), { minLength: 1, maxLength: 40 }),
      (operations) => {
        const sim = clients("a", "b", "c");
        for (const operation of operations) {
          const path = `p${operation.path}.md`;
          sim.pull(operation.client, { order: operation.value % 2 ? "reverse" : "hash", duplicate: operation.value % 3 + 1 });
          sim.edit(operation.client, path, put(`h${operation.value}`));
          sim.freeze(operation.client, "vault", path);
          sim.publishNext(operation.client);
        }
        for (const client of ["a", "b", "c"]) sim.pull(client, { order: client === "a" ? "forward" : "reverse", duplicate: 3 });
        for (let path = 0; path < 5; path += 1) {
          expect(sim.registerHeads("a", "vault", `p${path}.md`)).toEqual(sim.registerHeads("b", "vault", `p${path}.md`));
          expect(sim.registerHeads("b", "vault", `p${path}.md`)).toEqual(sim.registerHeads("c", "vault", `p${path}.md`));
        }
        sim.assertInvariants();
      },
    ), { numRuns: 100, seed: 20260713 });
  });
});

function clients(...ids: string[]): DeterministicSyncSimulator {
  const sim = new DeterministicSyncSimulator();
  for (const id of ids) sim.createClient(id);
  return sim;
}
