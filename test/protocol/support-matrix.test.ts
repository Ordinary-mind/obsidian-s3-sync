import { readFileSync } from "node:fs";
import { statSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("protocol support matrix", () => {
  it("keeps the Node 22 baseline and unverified adapter/provider contracts explicit", () => {
    const matrix = JSON.parse(
      readFileSync(new URL("../../protocol/support-matrix.json", import.meta.url), "utf8"),
    ) as {
      protocol: number;
      status: string;
      runtimes: Array<{ name: string; version?: string; status: string; staticApi?: string[] }>;
      objectStores: Array<{ name: string; status: string }>;
      unicodeRuntimeSourceBytes: { caseFolding: number; nfc: number; total: number };
    };
    expect(matrix.protocol).toBe(1);
    expect(matrix.status).toBe("task-0-complete");
    expect(matrix.runtimes).toContainEqual(
      expect.objectContaining({ name: "Node.js", version: "22.x", status: "supported-for-protocol-tests" }),
    );
    expect(matrix.runtimes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Obsidian desktop", status: "verified-runtime-contract-tests" }),
      expect.objectContaining({ name: "Obsidian mobile", status: "not-supported-in-v1-desktop-only" }),
    ]));
    expect(matrix.runtimes.filter((runtime) => runtime.name.startsWith("Obsidian"))).toEqual(
      expect.arrayContaining([expect.objectContaining({ staticApi: expect.arrayContaining(["vault.configDir"]) })]),
    );
    expect(matrix.objectStores).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "AWS S3", status: "not-claimed-for-v1", claimedForV1: false }),
      expect.objectContaining({ name: "MinIO or equivalent S3-compatible storage", status: "verified-real-contract-tests", claimedForV1: true }),
      expect.objectContaining({ name: "Baidu Cloud BOS S3-compatible storage", status: "verified-real-contract-tests", claimedForV1: true }),
    ]));
    expect(process.versions.node.split(".")[0]).toBe("22");
    const caseFolding = statSync(new URL("../../protocol/unicode/15.1.0/case-folding.ts", import.meta.url)).size;
    const nfc = statSync(new URL("../../protocol/unicode/15.1.0/nfc.ts", import.meta.url)).size;
    expect(matrix.unicodeRuntimeSourceBytes).toEqual(expect.objectContaining({
      caseFolding,
      nfc,
      total: caseFolding + nfc,
    }));
  });
});
