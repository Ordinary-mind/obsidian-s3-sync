import { describe, expect, it } from "vitest";
import { inferS3ConnectionHints } from "../../src/connection-hints";

describe("S3 connection hints", () => {
  it("recognizes Baidu BOS, AWS and loopback defaults", () => {
    expect(inferS3ConnectionHints("https://s3.gz.bcebos.com")).toEqual({
      provider: "baidu",
      region: "gz",
      forcePathStyle: true,
    });
    expect(inferS3ConnectionHints("https://bucket.s3.eu-west-1.amazonaws.com")).toEqual({
      provider: "aws",
      region: "eu-west-1",
      forcePathStyle: false,
    });
    expect(inferS3ConnectionHints("http://127.0.0.1:9000")).toEqual({
      provider: "local",
      region: "us-east-1",
      forcePathStyle: true,
    });
    expect(inferS3ConnectionHints("http://[::1]:9000").provider).toBe("local");
  });

  it("does not guess custom S3-compatible endpoints", () => {
    expect(inferS3ConnectionHints("https://objects.example.com")).toEqual({});
    expect(inferS3ConnectionHints("not-a-url")).toEqual({});
  });
});
