import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { FakeRegister, FakeRegisterVersion } from "../support/fake-register";

describe("fixed register delivery vectors", () => {
  it("derives identical heads from reordered and duplicate delivery", () => {
    const vector = JSON.parse(
      readFileSync(new URL("../../protocol/vectors/register-delivery-order.json", import.meta.url), "utf8"),
    ) as { nodes: FakeRegisterVersion[]; deliveries: string[][]; expectedHeads: string[] };
    const catalog = new Map(vector.nodes.map((node) => [node.versionId, node]));

    for (const delivery of vector.deliveries) {
      const register = new FakeRegister(catalog);
      for (const versionId of delivery) register.deliver(versionId);
      expect(register.heads()).toEqual(vector.expectedHeads);
    }
  });
});
