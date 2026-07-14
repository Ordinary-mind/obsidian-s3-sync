import { describe, expect, it } from "vitest";
import { captureConfigDirtyIntent, configPublicationParents, configSnapshotMergeDisposition } from "../../core/config-causality";

describe("ConfigTree snapshot causality", () => {
  it("captures only projected ConfigTree heads and treats different whole Trees as conflicts", () => {
    const intent = captureConfigDirtyIntent({ projectedHeads: ["projected"], projectedTreeHash: "old-tree", generation: 1 });
    expect(intent.basisHeads).toEqual(["projected"]);
    expect(configSnapshotMergeDisposition("same", ["same", "same"])).toBe("adopt");
    expect(configSnapshotMergeDisposition("local", ["remote"])).toBe("conflict");
    expect(configSnapshotMergeDisposition("local", [])).toBe("publish-root");
  });

  it("publishes ordinary local changes from frozen projected heads without absorbing later observations", () => {
    const dirtyIntent = captureConfigDirtyIntent({
      projectedHeads: ["projected"],
      projectedTreeHash: "old-tree",
      generation: 2,
    });
    expect(configPublicationParents({
      projectLocal: true,
      resolveObservedConflict: false,
      projectedHeads: ["projected"],
      projectedTreeHash: "old-tree",
      observedHeads: ["projected", "later-remote"],
      dirtyIntent,
    })).toEqual(["projected"]);
    expect(configPublicationParents({
      projectLocal: true,
      resolveObservedConflict: true,
      projectedHeads: ["projected"],
      projectedTreeHash: "old-tree",
      observedHeads: ["later-remote", "projected"],
      dirtyIntent,
    })).toEqual(["later-remote", "projected"]);
  });

  it("uses a root snapshot for an unprojected local Tree even when a remote head exists", () => {
    expect(configPublicationParents({
      projectLocal: true,
      resolveObservedConflict: true,
      projectedHeads: [],
      projectedTreeHash: null,
      observedHeads: ["remote-root"],
    })).toEqual([]);
  });
});
