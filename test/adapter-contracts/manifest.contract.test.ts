import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("v1 manifest contract", () => {
  it("declares the verified desktop API baseline and excludes unverified mobile runtimes", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8")) as {
      minAppVersion: string;
      isDesktopOnly: boolean;
    };
    expect(manifest).toEqual(expect.objectContaining({ minAppVersion: "1.7.7", isDesktopOnly: true }));
  });
});
