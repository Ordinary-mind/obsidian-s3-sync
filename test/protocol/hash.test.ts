import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ObjectIntegrityError,
  assertCommitObject,
  assertContentAddressedObject,
  assertObjectBodyHash,
  sha256Hex,
} from "../../protocol/hash";

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

  it("requires both key identity and body bytes to match before accepting an object", () => {
    const bytes = encoder.encode("content");
    const hash = sha256Hex(bytes);
    const root = ".obsidian-s3-sync/v1/repositories/123e4567-e89b-42d3-a456-426614174000";
    expect(() =>
      assertContentAddressedObject(`${root}/changes/sha256/${hash.slice(0, 2)}/${hash}.json`, hash, bytes),
    ).not.toThrow();
    expect(() => assertContentAddressedObject(`${root}/changes/sha256/00/${hash}.json`, hash, bytes)).toThrow();
    expect(() =>
      assertCommitObject(
        `${root}/commits/writer/00000000000000000001-${hash}.json`,
        "writer",
        "00000000000000000001",
        hash,
        bytes,
      ),
    ).not.toThrow();
  });
});
