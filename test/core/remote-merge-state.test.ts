import { describe, expect, it } from "vitest";
import { mergeVerifiedRegisterObservations } from "../../core/remote-merge-state";

describe("verified remote merge state", () => {
  it("updates observed state and pending apply without changing projection", () => {
    const projected = { "same.md": ["v1"], "changed.md": ["old"] };
    const result = mergeVerifiedRegisterObservations([
      { key: "vault:same.md", heads: ["v1"], pending: [], invalid: [], disposition: "resolved", valueHash: "a" },
      { key: "vault:changed.md", heads: ["v2"], pending: [], invalid: [], disposition: "resolved", valueHash: "b" },
      { key: "vault:waiting.md", heads: [], pending: ["v3"], invalid: [], disposition: "pending" },
    ], projected);
    expect(projected).toEqual({ "same.md": ["v1"], "changed.md": ["old"] });
    expect(result.pendingApply).toEqual({ "changed.md": { targetHeads: ["v2"], targetValueHash: "b" } });
    expect(result.observedRegisters["vault:waiting.md"].pending).toEqual(["v3"]);
  });
});
