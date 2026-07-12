import { describe, expect, it } from "vitest";
import { validateRepositoryEndpoint } from "../../core/locator";
describe("repository endpoint", () => { it("requires HTTPS except explicit loopback test mode", () => {
  const base = { endpoint: "https://s3.example", region: "us-east-1", bucket: "vault", forcePathStyle: false };
  expect(validateRepositoryEndpoint(base)).toBe(true);
  expect(validateRepositoryEndpoint({ ...base, endpoint: "http://s3.example" })).toBe(false);
  expect(validateRepositoryEndpoint({ ...base, endpoint: "http://127.0.0.1:9000" }, true)).toBe(true);
}); });
