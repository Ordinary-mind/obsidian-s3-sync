import { describe, expect, it } from "vitest";
import { captureConfigDirtyIntent, configSnapshotMergeDisposition } from "../../core/config-causality";

describe("ConfigTree snapshot causality", () => {
  it("captures only projected ConfigTree heads and treats different whole Trees as conflicts", () => {
    const intent = captureConfigDirtyIntent({ projectedHeads: ["projected"], projectedTreeHash: "old-tree", generation: 1 });
    expect(intent.basisHeads).toEqual(["projected"]);
    expect(configSnapshotMergeDisposition("same", ["same", "same"])).toBe("adopt");
    expect(configSnapshotMergeDisposition("local", ["remote"])).toBe("conflict");
    expect(configSnapshotMergeDisposition("local", [])).toBe("publish-root");
  });
});
