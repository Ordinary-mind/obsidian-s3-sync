import { describe, expect, it } from "vitest";
import { createDeletionEvidence, mayCreateDeletionEvidence } from "../../core/presence";

describe("local presence evidence", () => {
  it("allows deletion evidence only after a complete stable direct recheck", () => {
    expect(mayCreateDeletionEvidence("confirmed-absent", true, true, true)).toBe(true);
    for (const presence of ["present", "unknown", "out-of-scope"] as const) expect(mayCreateDeletionEvidence(presence, true, true, true)).toBe(false);
    expect(mayCreateDeletionEvidence("confirmed-absent", false, true, true)).toBe(false);
  });
  it("captures the scope revision with confirmed deletion evidence", () => {
    expect(createDeletionEvidence("notes/a.md", "scope-1", 1, "confirmed-absent", true, true, true)).toEqual({ path: "notes/a.md", scopeRevision: "scope-1", confirmedAt: 1 });
    expect(createDeletionEvidence("notes/a.md", "scope-1", 1, "unknown", true, true, true)).toBeUndefined();
  });
});
