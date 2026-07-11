import { describe, expect, it } from "vitest";
import { reduceRegister } from "../../core/register";

describe("core register reduction", () => {
  it("keeps concurrent heads and lets a verified resolution supersede them", () => {
    const root = "root";
    expect(reduceRegister([{ versionId: root, logicalKey: "vault:a", parents: [] }, { versionId: "a", logicalKey: "vault:a", parents: [root] }, { versionId: "b", logicalKey: "vault:a", parents: [root] }]).heads).toEqual(["a", "b"]);
    expect(reduceRegister([{ versionId: root, logicalKey: "vault:a", parents: [] }, { versionId: "a", logicalKey: "vault:a", parents: [root] }, { versionId: "b", logicalKey: "vault:a", parents: [root] }, { versionId: "r", logicalKey: "vault:a", parents: ["a", "b"] }]).heads).toEqual(["r"]);
  });
  it("separates missing parents from invalid cross-register and cyclic links", () => {
    expect(reduceRegister([{ versionId: "p", logicalKey: "vault:a", parents: ["missing"] }])).toEqual({ heads: [], pending: ["p"], invalid: [] });
    expect(reduceRegister([{ versionId: "a", logicalKey: "vault:a", parents: [] }, { versionId: "b", logicalKey: "config:portable", parents: ["a"] }]).invalid).toEqual(["b"]);
    expect(reduceRegister([{ versionId: "a", logicalKey: "vault:a", parents: ["b"] }, { versionId: "b", logicalKey: "vault:a", parents: ["a"] }]).invalid).toEqual(["a", "b"]);
  });
});
