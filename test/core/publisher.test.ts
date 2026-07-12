import { describe, expect, it } from "vitest";
import { assertPublishOrder, publishableStages } from "../../core/publisher";

describe("immutable publication order", () => {
  it("makes Commit publication last", () => {
    expect(() => assertPublishOrder([], "commit")).toThrow("out of order");
    expect(() => assertPublishOrder(["blob", "config-tree", "change-chunk"], "commit")).not.toThrow();
  });
  it("withholds Commit until every immutable dependency is ready", () => {
    expect(publishableStages({ blobsReady: true, configTreesReady: false, chunksReady: true })).not.toContain("commit");
    expect(publishableStages({ blobsReady: true, configTreesReady: true, chunksReady: true })).toEqual(["blob", "config-tree", "change-chunk", "commit"]);
  });
});
