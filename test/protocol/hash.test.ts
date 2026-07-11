import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ObjectIntegrityError, assertObjectBodyHash, sha256Hex } from "../../protocol/hash";

const encoder = new TextEncoder();

describe("content-addressed protocol objects", () => {
  it("recomputes a fixed vector hash from its exact canonical bytes", () => {
    const vector = JSON.parse(
      readFileSync(
        new URL("../../protocol/vectors/repository-descriptor-basic.json", import.meta.url),
        "utf8",
      ),
    );
    const bytes = encoder.encode(vector.canonicalJson);
    expect(sha256Hex(bytes)).toBe(vector.sha256);
    expect(() => assertObjectBodyHash(vector.sha256, bytes)).not.toThrow();
  });

  it("rejects tampered bytes even when the caller says they came from the expected key", () => {
    const hash = sha256Hex("original");
    expect(() => assertObjectBodyHash(hash, encoder.encode("tampered"))).toThrow(ObjectIntegrityError);
  });
});
