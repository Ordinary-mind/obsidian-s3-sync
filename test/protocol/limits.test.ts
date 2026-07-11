import { describe, expect, it } from "vitest";

import {
  isValidSequence,
  isWithinCollectionLimit,
  protocolLimits,
  utf8ByteLength,
  validateParsedJsonLimits,
} from "../../protocol/limits";

describe("v1 protocol resource limits", () => {
  it("counts UTF-8 bytes rather than JavaScript code units", () => {
    expect(utf8ByteLength("a")).toBe(1);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("😀")).toBe(4);
  });

  it("accepts the byte and depth boundaries and rejects one beyond", () => {
    expect(validateParsedJsonLimits("a".repeat(protocolLimits.jsonStringUtf8Bytes))).toEqual([]);
    expect(
      validateParsedJsonLimits("a".repeat(protocolLimits.jsonStringUtf8Bytes + 1)),
    ).toEqual(["json-string-bytes-exceeded"]);

    let atLimit: unknown = null;
    for (let index = 0; index < protocolLimits.jsonDepth - 1; index += 1) atLimit = [atLimit];
    expect(validateParsedJsonLimits(atLimit)).toEqual([]);
    expect(validateParsedJsonLimits([atLimit])).toEqual(["json-depth-exceeded"]);
  });

  it("validates the 20-digit sequence range without Number precision loss", () => {
    expect(isValidSequence("00000000000000000001")).toBe(true);
    expect(isValidSequence("18446744073709551615")).toBe(true);
    expect(isValidSequence("18446744073709551616")).toBe(false);
    expect(isValidSequence("00000000000000000000")).toBe(false);
  });

  it("rejects negative zero and integers that cannot be represented safely", () => {
    expect(validateParsedJsonLimits(-0)).toEqual(["json-number-not-safe-integer"]);
    expect(validateParsedJsonLimits(1.5)).toEqual(["json-number-not-safe-integer"]);
    expect(validateParsedJsonLimits(Number.MAX_SAFE_INTEGER + 1)).toEqual([
      "json-number-not-safe-integer",
    ]);
  });

  it("checks collection boundaries from deterministic counts instead of huge fixtures", () => {
    const cases = [
      ["parents", protocolLimits.mutationParents],
      ["chunk-mutations", protocolLimits.chunkMutations],
      ["commit-chunks", protocolLimits.commitChunks],
      ["config-tree-items", protocolLimits.configTreeItems],
    ] as const;
    for (const [name, limit] of cases) {
      expect(isWithinCollectionLimit(name, limit)).toBe(true);
      expect(isWithinCollectionLimit(name, limit + 1)).toBe(false);
    }
    expect(validateParsedJsonLimits(Array(protocolLimits.jsonArrayItems).fill(null))).toEqual([]);
    expect(validateParsedJsonLimits(Array(protocolLimits.jsonArrayItems + 1).fill(null))).toEqual([
      "json-array-items-exceeded",
    ]);
  });
});
