import { describe, expect, it } from "vitest";
import { canWriteAfterProbe } from "../../core/object-store";

describe("ObjectStore write capability", () => {
  it("does not permit protocol writes without proven atomic create", () => {
    expect(canWriteAfterProbe(false)).toBe(false);
    expect(canWriteAfterProbe(true)).toBe(true);
  });
});
