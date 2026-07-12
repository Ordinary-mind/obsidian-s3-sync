import { describe, expect, it } from "vitest";
import { decideOnboarding } from "../../core/onboarding";

describe("first onboarding decisions", () => {
  it("never auto-overwrites distinct local and remote content", () => {
    expect(decideOnboarding(undefined, undefined)).toBe("empty");
    expect(decideOnboarding("same", "same")).toBe("adopt");
    expect(decideOnboarding("local", undefined)).toBe("publish-local-root");
    expect(decideOnboarding(undefined, "remote")).toBe("project-remote");
    expect(decideOnboarding("local", "remote")).toBe("conflict");
  });
});
