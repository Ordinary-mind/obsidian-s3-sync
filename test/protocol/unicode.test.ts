import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import { unicode151CaseFolding } from "../../protocol/unicode/15.1.0/case-folding";
import { defaultCaseFold151, unicodeVersion } from "../../protocol/unicode";

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
});
