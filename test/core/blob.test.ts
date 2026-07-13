import { describe, expect, it } from "vitest";
import { buildBlobObject } from "../../core/blob";

describe("content addressed Blob", () => {
  it("uses the capture hash in the immutable Blob key and copies its bytes", () => {
    const bytes = new Uint8Array([1]);
    const blob = buildBlobObject("vault", "123e4567-e89b-42d3-a456-426614174000", { bytes, hash: "a".repeat(64), size: 1 });
    bytes[0] = 2;
    expect(blob.key).toBe(`vault/.obsidian-s3-sync/v1/repositories/123e4567-e89b-42d3-a456-426614174000/blobs/sha256/aa/${"a".repeat(64)}`);
    expect(blob.bytes).toEqual(new Uint8Array([1]));
  });
});
