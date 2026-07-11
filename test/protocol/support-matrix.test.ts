import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("protocol support matrix", () => {
  it("keeps the Node 22 protocol-test baseline and pending adapter contracts explicit", () => {
    const matrix = JSON.parse(
      readFileSync(new URL("../../protocol/support-matrix.json", import.meta.url), "utf8"),
    ) as {
      protocol: number;
      runtimes: Array<{ name: string; version?: string; status: string }>;
    };
    expect(matrix.protocol).toBe(1);
    expect(matrix.runtimes).toContainEqual(
      expect.objectContaining({ name: "Node.js", version: "22.x", status: "supported-for-protocol-tests" }),
    );
    expect(matrix.runtimes.filter((runtime) => runtime.name.startsWith("Obsidian"))).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "pending-adapter-contract-tests" })]),
    );
    expect(process.versions.node.split(".")[0]).toBe("22");
  });
});
