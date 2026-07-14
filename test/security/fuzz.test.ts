import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { canonicalizeProtocolJson, parseCanonicalProtocolJson } from "../../protocol/json";
import { normalizeVaultPath, vaultPathCaseFoldKey } from "../../core/path";
import { findStructuralConflicts } from "../../core/structural-conflict";
import { assertS3KeyLength } from "../../protocol/keys";
import { isConfigPathExcluded, isVaultPathExcluded } from "../../core/scope";
import { protocolLimits } from "../../protocol/limits";

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

  it("keeps ASCII case aliases equivalent for portable path segments", () => {
    fc.assert(fc.property(
      fc.array(fc.stringMatching(/^[A-Za-z0-9_-]+$/), { minLength: 1, maxLength: 4 }),
      (segments) => {
        const path = segments.join("/");
        expect(vaultPathCaseFoldKey(path.toUpperCase())).toBe(vaultPathCaseFoldKey(path.toLowerCase()));
      },
    ), { numRuns: 300, seed: 20260715 });
  });

  it("never lets suffixes escape permanent reserved roots", () => {
    fc.assert(fc.property(fc.stringMatching(/^[A-Za-z0-9_.-]+$/).filter((value) => value !== "." && value !== ".."), (suffix) => {
      const child = suffix || "state";
      expect(isVaultPathExcluded(`.custom/${child}`, ".custom", [".old"])).toBe(true);
      expect(isVaultPathExcluded(`.old/${child}`, ".custom", [".old"])).toBe(true);
      expect(isVaultPathExcluded(`.s3-sync-conflicts/${child}`, ".custom", [".old"])).toBe(true);
      expect(isConfigPathExcluded(`plugins/obsidian-s3-sync/${child}`, ".custom", [])).toBe(true);
      expect(isConfigPathExcluded(`.obsidian-s3-sync-local/${child}`, ".custom", [])).toBe(true);
    }), { numRuns: 300, seed: 20260716 });
  });

  it("rejects generated S3 keys beyond 1,024 UTF-8 bytes", () => {
    fc.assert(fc.property(fc.integer({ min: 1025, max: 1400 }), (bytes) => {
      expect(() => assertS3KeyLength("x".repeat(bytes))).toThrow("1,024");
    }), { numRuns: 100, seed: 20260717 });
  });

  it("rejects duplicate JSON keys regardless of the generated key name", () => {
    fc.assert(fc.property(fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,20}$/), (key) => {
      const encodedKey = JSON.stringify(key);
      const source = new TextEncoder().encode(`{${encodedKey}:1,${encodedKey}:2}`);
      expect(() => parseCanonicalProtocolJson(source, protocolLimits.formatBytes)).toThrow(
        expect.objectContaining({ code: "duplicate-key" }),
      );
    }), { numRuns: 200, seed: 20260718 });
  });
});
