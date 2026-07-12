import { describe, expect, it } from "vitest";
import { nextSequence } from "../../core/sequence";

describe("20 digit writer sequence", () => {
  it("uses BigInt beyond Number precision and rejects uint64 overflow", () => {
    expect(nextSequence("00000000009007199253")).toBe("00000000009007199254");
    expect(nextSequence("18446744073709551614")).toBe("18446744073709551615");
    expect(() => nextSequence("18446744073709551615")).toThrow("exhausted");
  });
});
