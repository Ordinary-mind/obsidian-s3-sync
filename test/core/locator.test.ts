import { describe, expect, it } from "vitest";
import { createRepositoryLocator, repositoryFingerprint, repositoryRoot, validateRepositoryEndpoint } from "../../core/locator";
describe("repository endpoint", () => { it("requires an HTTPS origin except explicit loopback test mode", () => {
  const base = { endpoint: "https://s3.example", region: "us-east-1", bucket: "vault", forcePathStyle: false };
  expect(validateRepositoryEndpoint(base)).toBe(true);
  expect(validateRepositoryEndpoint({ ...base, endpoint: "http://s3.example" })).toBe(false);
  expect(validateRepositoryEndpoint({ ...base, endpoint: "http://127.0.0.1:9000" }, true)).toBe(true);
  expect(validateRepositoryEndpoint({ ...base, endpoint: "https://s3.example/path" })).toBe(false);
  expect(validateRepositoryEndpoint({ ...base, endpoint: "https://user:secret@s3.example" })).toBe(false);
  expect(validateRepositoryEndpoint({ ...base, region: "x".repeat(129) })).toBe(false);
}); });

describe("repository locator", () => {
  it("normalizes its Prefix and freezes the result", () => {
    const locator = createRepositoryLocator({ endpoint: "https://s3.example", region: "us-east-1", bucket: "vault", forcePathStyle: true, prefix: "/notes/main/" });
    expect(locator.normalizedPrefix).toBe("notes/main");
    expect(Object.isFrozen(locator)).toBe(true);
    expect(repositoryRoot(locator, "123e4567-e89b-42d3-a456-426614174000")).toBe("notes/main/.obsidian-s3-sync/v1/repositories/123e4567-e89b-42d3-a456-426614174000");
    const first = repositoryFingerprint(locator, "123e4567-e89b-42d3-a456-426614174000", "a".repeat(64));
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(repositoryFingerprint(locator, "123e4567-e89b-42d3-a456-426614174000", "b".repeat(64))).not.toBe(first);
  });
});
