import { describe, expect, it } from "vitest";
import { decideStateLossRecovery } from "../../core/reattach";

describe("state-loss reattachment", () => {
  it("never treats a non-empty local Vault as safe for automatic rebuild", () => {
    expect(decideStateLossRecovery(false)).toBe("rebuild-empty-local");
    expect(decideStateLossRecovery(true)).toBe("require-non-destructive-onboarding");
  });
});
