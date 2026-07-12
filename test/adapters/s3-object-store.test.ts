import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("v1 S3 ObjectStore adapter contract", () => {
  it("uses conditional immutable PUT and does not expose DeleteObject", () => {
    const source = readFileSync(new URL("../../adapters/s3-object-store.ts", import.meta.url), "utf8");
    expect(source).toContain('IfNoneMatch: "*"');
    expect(source).not.toContain("DeleteObjectCommand");
  });
});
