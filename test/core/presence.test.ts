import { describe, expect, it } from "vitest";
import { mayCreateDeletionEvidence } from "../../core/presence";

describe("local presence evidence", () => {
  it("allows deletion evidence only after a complete stable direct recheck", () => {
    expect(mayCreateDeletionEvidence("confirmed-absent", true, true, true)).toBe(true);
    for (const presence of ["present", "unknown", "out-of-scope"] as const) expect(mayCreateDeletionEvidence(presence, true, true, true)).toBe(false);
    expect(mayCreateDeletionEvidence("confirmed-absent", false, true, true)).toBe(false);
  });
});
