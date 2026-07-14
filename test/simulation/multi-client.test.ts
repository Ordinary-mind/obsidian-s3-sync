import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DeterministicSyncSimulator,
  SimulatedLocalIoError,
  SimulatedOfflineError,
  simulatedLocalIoBoundaries,
  type SimulatedLocalIoBoundary,
} from "../../core/deterministic-simulator";

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

  it("controls offline publication, late parent visibility, and pending state across restart", () => {
    const sim = clients("a", "b");
    sim.edit("a", "note.md", put("root"));
    const root = sim.freeze("a", "vault", "note.md");
    sim.publishNext("a", { visibleAfter: 10 });
    sim.edit("a", "note.md", put("child"));
    const child = sim.freeze("a", "vault", "note.md");
    sim.publishNext("a");

    sim.pull("b", { order: "reverse", duplicate: 3 });
    expect(sim.pendingApply("b")).toEqual(["vault:note.md"]);
    expect(sim.registerHeads("b", "vault", "note.md")).toEqual([]);
    const snapshot = sim.snapshotClient("b");
    sim.restoreClient(snapshot);
    expect(sim.pendingApply("b")).toEqual(["vault:note.md"]);

    sim.advanceRemoteVisibility(10);
    sim.pull("b", { order: "reverse", duplicate: 4 });
    expect(sim.registerHeads("b", "vault", "note.md")).toEqual([child.versionId]);
    expect(sim.pendingApply("b")).toEqual([]);
    expect(root.versionId).not.toBe(child.versionId);

    sim.disconnect("b");
    sim.edit("b", "offline.md", put("offline"));
    sim.freeze("b", "vault", "offline.md");
    expect(() => sim.publishNext("b")).toThrow(SimulatedOfflineError);
    expect(() => sim.pull("b")).toThrow(SimulatedOfflineError);
    sim.reconnect("b");
    sim.publishNext("b");
    sim.pull("a");
    sim.pull("b");
    sim.assertConvergedHeads();
    sim.assertInvariants();
  });

  it("retains pending work and frozen bytes across every deterministic local I/O boundary", () => {
    const exercised = new Set<SimulatedLocalIoBoundary>();

    for (const boundary of ["capture-read", "staging-write", "state-write"] as const) {
      const sim = clients("a");
      sim.edit("a", "note.md", put(boundary));
      sim.injectLocalIoFailure("a", boundary);
      expect(() => sim.freeze("a", "vault", "note.md")).toThrow(SimulatedLocalIoError);
      expect(sim.outbox("a")).toEqual([]);
      sim.freeze("a", "vault", "note.md");
      for (const seen of sim.localIoTrace("a")) exercised.add(seen);
      sim.assertInvariants();
    }

    {
      const sim = clients("a");
      sim.injectLocalIoFailure("a", "state-read");
      expect(() => sim.snapshotClient("a")).toThrow(SimulatedLocalIoError);
      sim.snapshotClient("a");
      for (const seen of sim.localIoTrace("a")) exercised.add(seen);
    }

    for (const boundary of [
      "scan-list",
      "preimage-check",
      "recovery-move",
      "recovery-hash",
      "install",
      "projection-account",
    ] as const) {
      const sim = clients("a", "b");
      sim.edit("a", "note.md", put(boundary));
      const published = sim.freeze("a", "vault", "note.md");
      sim.publishNext("a");
      sim.injectLocalIoFailure("b", boundary);
      expect(() => sim.pull("b")).toThrow(SimulatedLocalIoError);
      if (boundary !== "scan-list") expect(sim.pendingApply("b")).toEqual(["vault:note.md"]);
      const snapshot = sim.snapshotClient("b");
      sim.restoreClient(snapshot);
      sim.pull("b", { order: "reverse", duplicate: 2 });
      expect(sim.registerHeads("b", "vault", "note.md")).toEqual([published.versionId]);
      expect(sim.pendingApply("b")).toEqual([]);
      for (const seen of sim.localIoTrace("b")) exercised.add(seen);
      sim.assertInvariants();
    }

    expect([...exercised].sort()).toEqual([...simulatedLocalIoBoundaries].sort());
  });

  it("randomizes create, edit, delete, rename, offline, reconnect, resolution, restart, and Config snapshots", () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        action: fc.constantFrom("create", "edit", "delete", "rename", "offline", "reconnect", "resolve", "restart", "config", "pull"),
        client: fc.constantFrom("a", "b", "c"),
        path: fc.integer({ min: 0, max: 4 }),
        value: fc.integer({ min: 0, max: 1_000_000 }),
      }), { minLength: 1, maxLength: 40 }),
      (operations) => {
        const sim = clients("a", "b", "c");
        const mandatory = ["create", "edit", "delete", "rename", "offline", "reconnect", "resolve", "restart", "config", "pull"]
          .map((action, index) => ({ action, client: (["a", "b", "c"] as const)[index % 3], path: index % 5, value: index + 1 }));
        for (const operation of [...mandatory, ...operations]) {
          runRandomOperation(sim, operation as RandomOperation);
          sim.assertInvariants();
        }
        for (const client of ["a", "b", "c"]) {
          sim.reconnect(client);
          publishAll(sim, client);
        }
        sim.advanceRemoteVisibility(100);
        for (const client of ["a", "b", "c"]) {
          sim.pull(client, { order: client === "a" ? "forward" : "reverse", duplicate: 3 });
        }
        sim.assertConvergedHeads();
        sim.assertInvariants();
      },
    ), { numRuns: 100, seed: 20260714 });
  });
});

type RandomOperation = {
  action: "create" | "edit" | "delete" | "rename" | "offline" | "reconnect" | "resolve" | "restart" | "config" | "pull";
  client: "a" | "b" | "c";
  path: number;
  value: number;
};

function runRandomOperation(sim: DeterministicSyncSimulator, operation: RandomOperation): void {
  const path = `p${operation.path}.md`;
  if (operation.action === "offline") {
    sim.disconnect(operation.client);
    return;
  }
  if (operation.action === "reconnect") {
    sim.reconnect(operation.client);
    publishAll(sim, operation.client);
    return;
  }
  if (operation.action === "restart") {
    const pending = sim.pendingApply(operation.client);
    const snapshot = sim.snapshotClient(operation.client);
    sim.restoreClient(snapshot);
    expect(sim.pendingApply(operation.client)).toEqual(pending);
    return;
  }
  if (operation.action === "pull") {
    if (sim.isOnline(operation.client)) {
      sim.pull(operation.client, { order: operation.value % 2 ? "reverse" : "hash", duplicate: operation.value % 3 + 1 });
    }
    return;
  }
  if (operation.action === "resolve") {
    if (!sim.isOnline(operation.client)) return;
    sim.pull(operation.client, { order: "reverse", duplicate: 2 });
    const conflict = sim.conflicts(operation.client)[0];
    if (!conflict) return;
    const separator = conflict.indexOf(":");
    const channel = conflict.slice(0, separator) as "vault" | "config";
    sim.resolve(operation.client, channel, conflict.slice(separator + 1), put(`resolved-${operation.value}`));
    publishAll(sim, operation.client);
    return;
  }
  if (operation.action === "config") {
    sim.edit(operation.client, `profile-${operation.path}`, put(`tree-${operation.value}`), "config");
    freezeIfAllowed(sim, operation.client, "config", `profile-${operation.path}`);
  } else if (operation.action === "delete") {
    sim.edit(operation.client, path, { kind: "delete" });
    freezeIfAllowed(sim, operation.client, "vault", path);
  } else if (operation.action === "rename") {
    const target = `renamed-${operation.path}.md`;
    sim.rename(operation.client, path, target, put(`rename-${operation.value}`));
    freezeIfAllowed(sim, operation.client, "vault", path);
    freezeIfAllowed(sim, operation.client, "vault", target);
  } else {
    sim.edit(operation.client, path, put(`${operation.action}-${operation.value}`));
    freezeIfAllowed(sim, operation.client, "vault", path);
  }
  if (sim.isOnline(operation.client)) publishAll(sim, operation.client);
}

function freezeIfAllowed(
  sim: DeterministicSyncSimulator,
  clientId: string,
  channel: "vault" | "config",
  logicalKey: string,
): void {
  try {
    sim.freeze(clientId, channel, logicalKey);
  } catch (error) {
    if (!(error instanceof Error) || (!error.message.includes("root tombstone") && !error.message.includes("root put"))) throw error;
  }
}

function publishAll(sim: DeterministicSyncSimulator, clientId: string): void {
  while (sim.outbox(clientId).some((entry) => entry.state === "frozen")) sim.publishNext(clientId);
}

function clients(...ids: string[]): DeterministicSyncSimulator {
  const sim = new DeterministicSyncSimulator();
  for (const id of ids) sim.createClient(id);
  return sim;
}
