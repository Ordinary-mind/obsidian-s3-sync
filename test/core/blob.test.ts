import { describe, expect, it } from "vitest";
import { assertBlobSize, buildBlobObject } from "../../core/blob";
import { sha256Hex } from "../../protocol/hash";

describe("content addressed Blob", () => {
  it("uses the capture hash in the immutable Blob key and copies its bytes", () => {
    const bytes = new Uint8Array([1]);
    const hash = sha256Hex(bytes);
    const blob = buildBlobObject("vault", "123e4567-e89b-42d3-a456-426614174000", { bytes, hash, size: 1 });
    bytes[0] = 2;
    expect(blob.key).toBe(`vault/.obsidian-s3-sync/v1/repositories/123e4567-e89b-42d3-a456-426614174000/blobs/sha256/${hash.slice(0, 2)}/${hash}`);
    expect(blob.bytes).toEqual(new Uint8Array([1]));
  });
  it("rejects inconsistent captures and reports protocol or platform size limits", () => {
    const bytes = new Uint8Array([1]);
    const input = { bytes, hash: sha256Hex(bytes), size: 1 };
    expect(() => buildBlobObject("", "123e4567-e89b-42d3-a456-426614174000", { ...input, size: 2 })).toThrow("size differs");
    expect(() => buildBlobObject("", "123e4567-e89b-42d3-a456-426614174000", { ...input, hash: "a".repeat(64) })).toThrow("hash differs");
    expect(() => assertBlobSize(5_000_000_001)).toThrow("protocol limit");
    expect(() => assertBlobSize(101, 100)).toThrow("platform limit");
  });
});
