import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { unicode151CaseFolding } from "../../protocol/unicode/15.1.0/case-folding";
import { defaultCaseFold151, normalizeNfc151, unicodeVersion } from "../../protocol/unicode";
import { compareUtf8, validateChangeChunkObject } from "../../protocol/semantics";

describe("Unicode 15.1 Default Case Folding", () => {
  it("uses the generated C/F mapping rather than the host locale", () => {
    expect(unicodeVersion).toBe("15.1.0");
    expect(defaultCaseFold151("ASCII")).toBe("ascii");
    expect(defaultCaseFold151("Straße")).toBe("strasse");
    expect(defaultCaseFold151("Kelvin")).toBe("kelvin");
    expect(defaultCaseFold151("İ")).toBe("i̇");
  });

  it("keeps the generated mapping bytes fixed", () => {
    expect(Object.keys(unicode151CaseFolding)).toHaveLength(1530);
    expect(
      createHash("sha256").update(JSON.stringify(unicode151CaseFolding), "utf8").digest("hex"),
    ).toBe("980ac20c80291b5e18ceba59545e9ec51e88bc2723a0591545db4211623c235e");
  });

  it("normalizes canonical decomposition, combining order and Hangul with Unicode 15.1 data", () => {
    expect(normalizeNfc151("e\u0301")).toBe("é");
    expect(normalizeNfc151("Å")).toBe("Å");
    expect(normalizeNfc151("a\u0315\u0300")).toBe("à\u0315");
    expect(normalizeNfc151("\u1100\u1161\u11a8")).toBe("각");
    expect(() => normalizeNfc151("\ud800")).toThrow(RangeError);
  });

  it("keeps the generated NFC table bytes fixed", () => {
    const generated = readFileSync(new URL("../../protocol/unicode/15.1.0/nfc.ts", import.meta.url));
    expect(createHash("sha256").update(generated).digest("hex")).toBe(
      "171030da502141efc3029039642d07fd2b8fd650d3923edd060a59e55aa13c55",
    );
  });

  it("replays Unicode 15.1 NFC and case-fold path alias vectors", () => {
    const vectors = JSON.parse(
      readFileSync(new URL("../../protocol/vectors/unicode-path-aliases.json", import.meta.url), "utf8"),
    ) as Array<{ input: string; nfc: string; caseFoldKey: string }>;
    for (const vector of vectors) {
      expect(normalizeNfc151(vector.input)).toBe(vector.nfc);
      expect(defaultCaseFold151(normalizeNfc151(vector.input))).toBe(vector.caseFoldKey);
    }
  });

  it("replays runtime-independent UTF-8 ordering, case-fold and prefix-conflict vectors", () => {
    const vector = JSON.parse(
      readFileSync(new URL("../../protocol/vectors/unicode-ordering.json", import.meta.url), "utf8"),
    ) as {
      unicodeVersion: string;
      utf8Unsorted: string[];
      utf8Sorted: string[];
      caseFoldAliases: [string, string];
      prefixConflict: [string, string];
    };
    expect(vector.unicodeVersion).toBe(unicodeVersion);
    expect([...vector.utf8Unsorted].sort(compareUtf8)).toEqual(vector.utf8Sorted);
    expect(defaultCaseFold151(vector.caseFoldAliases[0])).toBe(defaultCaseFold151(vector.caseFoldAliases[1]));
    expect(validateChangeChunkObject({
      protocol: 1,
      repositoryId: "123e4567-e89b-42d3-a456-426614174000",
      descriptorHash: "a".repeat(64),
      channel: "vault",
      chunkIndex: 0,
      chunkCount: 1,
      mutations: vector.prefixConflict.map((path, index) => ({
        path,
        kind: "put" as const,
        blobHash: String(index + 1).repeat(64),
        size: 1,
        parents: [],
      })),
    })).toContain("vault-put-path-prefix-conflict");
  });
});
