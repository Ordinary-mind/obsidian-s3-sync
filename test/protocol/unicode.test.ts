import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { unicode151CaseFolding } from "../../protocol/unicode/15.1.0/case-folding";
import { defaultCaseFold151, normalizeNfc151, unicodeVersion } from "../../protocol/unicode";

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
});
