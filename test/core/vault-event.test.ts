import { describe, expect, it } from "vitest";
import { bindRootDeletePredecessor, clearVaultEventsThroughGeneration, latestVaultEvent, recordVaultEvent, recordVaultRename } from "../../core/vault-event";
import { decideResolvedRemotePut } from "../../core/pull-decision";

describe("v1 Vault causal events", () => {
  it("keeps the first projected basis across continuous events", () => {
    const first = recordVaultEvent([], { id: "1", kind: "upsert", path: "notes/a.md", projectedHeads: ["before"] });
    const second = recordVaultEvent(first, { id: "2", kind: "upsert", path: "notes/a.md", projectedHeads: ["before", "remote"] });
    expect(latestVaultEvent(second, "notes/a.md")).toMatchObject({ generation: 2, basisHeads: ["before"] });
  });

  it("records rename delete and upsert in one transaction", () => {
    expect(recordVaultRename([], {
      transactionId: "rename-1",
      deleteId: "delete-1",
      upsertId: "put-1",
      oldPath: "old.md",
      newPath: "new.md",
      oldProjectedHeads: ["old-head"],
      newProjectedHeads: [],
    })).toEqual([
      { id: "delete-1", transactionId: "rename-1", kind: "delete", path: "old.md", generation: 1, basisHeads: ["old-head"] },
      { id: "put-1", transactionId: "rename-1", kind: "upsert", path: "new.md", generation: 1, basisHeads: [] },
    ]);
  });

  it("clears only generations included in a published capture", () => {
    const first = recordVaultEvent([], { id: "1", kind: "upsert", path: "a.md", projectedHeads: [] });
    const second = recordVaultEvent(first, { id: "2", kind: "upsert", path: "a.md", projectedHeads: ["later"] });
    expect(clearVaultEventsThroughGeneration(second, "a.md", 1)).toEqual([
      { id: "2", kind: "upsert", path: "a.md", generation: 2, basisHeads: [] },
    ]);
    const afterPublish = recordVaultEvent([], { id: "3", kind: "upsert", path: "a.md", projectedHeads: ["published"], previousGeneration: 2 });
    expect(afterPublish[0].generation).toBe(3);
  });

  it("collapses delete followed by recreate to the final put with the original basis", () => {
    const deleted = recordVaultEvent([], { id: "delete", kind: "delete", path: "a.md", projectedHeads: ["before"] });
    const recreated = recordVaultEvent(deleted, { id: "put", kind: "upsert", path: "a.md", projectedHeads: ["remote-later"] });
    expect(latestVaultEvent(recreated, "a.md")).toMatchObject({ kind: "upsert", generation: 2, basisHeads: ["before"] });
  });

  it("preserves the old projection when disk change precedes its delayed Vault event", () => {
    expect(decideResolvedRemotePut({ localExists: true, projectedHash: "old", currentHash: "local", remoteHash: "remote" })).toBe("conflict");
    const delayed = recordVaultEvent([], { id: "late", kind: "upsert", path: "a.md", projectedHeads: ["old-head"] });
    expect(latestVaultEvent(delayed, "a.md")?.basisHeads).toEqual(["old-head"]);
  });
  it("binds a delete after a frozen root put to that exact local predecessor", () => {
    const put = recordVaultEvent([], { id: "put", kind: "upsert", path: "new.md", projectedHeads: [] });
    const deleted = recordVaultEvent(put, { id: "delete", kind: "delete", path: "new.md", projectedHeads: ["remote-later"] });
    const bound = bindRootDeletePredecessor(deleted, "new.md", 1, "commit:0:0");
    expect(latestVaultEvent(bound, "new.md")).toMatchObject({ basisHeads: [], localPredecessorVersion: "commit:0:0" });
  });
});
