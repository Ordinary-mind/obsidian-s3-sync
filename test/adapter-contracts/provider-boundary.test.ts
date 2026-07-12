import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("provider boundary contract", () => {
  it("keeps AWS SDK imports out of the protocol and domain core", () => {
    for (const path of [...sourceFiles("core"), ...sourceFiles("protocol")]) {
      expect(readFileSync(path, "utf8"), path).not.toContain("@aws-sdk/");
    }
    expect(readFileSync("adapters/s3-object-store.ts", "utf8")).toContain("@aws-sdk/client-s3");
  });
});
