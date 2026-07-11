import { describe, expect, it } from "vitest";

import { classifyAnchorRead } from "../../protocol/anchors";

describe("known immutable anchors", () => {
  it("does not treat a retried missing anchor as an empty repository", () => {
    expect(classifyAnchorRead(["missing"])).toBe("transient-missing");
    expect(classifyAnchorRead(["missing", "missing"])).toBe("missing-after-retry");
    expect(classifyAnchorRead(["missing", "readable"])).toBe("readable");
  });
});
