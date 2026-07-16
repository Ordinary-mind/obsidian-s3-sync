import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("manifest contract", () => {
  it("declares the verified desktop API baseline and excludes unverified mobile runtimes", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8")) as {
      minAppVersion: string;
      isDesktopOnly: boolean;
    };
    expect(manifest).toEqual(expect.objectContaining({ minAppVersion: "1.7.7", isDesktopOnly: true }));
    const versions = JSON.parse(readFileSync(new URL("../../versions.json", import.meta.url), "utf8"));
    expect(versions["0.1.0"]).toBe(manifest.minAppVersion);
  });

  it("ships the three root release artifacts without a dist directory", () => {
    for (const file of ["main.js", "manifest.json", "styles.css"]) {
      expect(existsSync(new URL(`../../${file}`, import.meta.url))).toBe(true);
    }
    expect(existsSync(new URL("../../dist", import.meta.url))).toBe(false);
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(packageJson.main).toBe("main.js");
  });
});
