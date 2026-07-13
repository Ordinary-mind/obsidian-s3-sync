import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { canonicalizeProtocolJson } from "../../protocol/json";
import { normalizeVaultPath, vaultPathCaseFoldKey } from "../../core/path";
import { findStructuralConflicts } from "../../core/structural-conflict";

describe("security fuzz boundaries", () => {
  it("never accepts traversal or absolute path segments", () => {
    fc.assert(fc.property(fc.array(fc.string({ minLength: 1, maxLength: 12 }), { minLength: 0, maxLength: 5 }), (segments) => {
      for (const candidate of [`../${segments.join("/")}`, `/${segments.join("/")}`, [...segments, ".."].join("/"), [...segments, ""].join("/")]) {
        expect(() => normalizeVaultPath(candidate)).toThrow();
      }
    }), { numRuns: 300, seed: 20260713 });
  });

  it("rejects unpaired surrogate strings before canonical output", () => {
    fc.assert(fc.property(fc.integer({ min: 0xd800, max: 0xdfff }), (unit) => {
      expect(() => canonicalizeProtocolJson({ value: String.fromCharCode(unit) })).toThrow("scalar");
    }), { numRuns: 300, seed: 20260714 });
  });

  it("finds the same prefix collision independent of delivery order and locale", () => {
    const heads = [{ path: "Straße", versionId: "one" }, { path: "Straße/child", versionId: "two" }];
    expect(findStructuralConflicts(heads)).toEqual(findStructuralConflicts([...heads].reverse()));
    expect(vaultPathCaseFoldKey("Straße")).toBe(vaultPathCaseFoldKey("STRASSE"));
  });
});
