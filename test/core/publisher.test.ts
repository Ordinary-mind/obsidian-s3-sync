import { describe, expect, it } from "vitest";
import { assertPublishOrder } from "../../core/publisher";

describe("immutable publication order", () => {
  it("makes Commit publication last", () => {
    expect(() => assertPublishOrder([], "commit")).toThrow("out of order");
    expect(() => assertPublishOrder(["blob", "config-tree", "change-chunk"], "commit")).not.toThrow();
  });
});
