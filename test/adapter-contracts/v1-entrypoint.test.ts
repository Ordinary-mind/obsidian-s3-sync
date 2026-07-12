import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("v1 plugin entrypoint contract", () => {
  it("does not initialize or subscribe the legacy manifest sync engine", () => {
    const source = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
    expect(source).toContain('from "./sync-engine"');
    expect(source).not.toContain("this.registerVaultEvents();");
    expect(source.match(/^\s*this\.rebuildEngine\(\);$/gm) ?? []).toHaveLength(0);
    expect(source).toContain("V1RepositoryService");
  });
});
