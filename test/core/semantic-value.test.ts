import { describe, expect, it } from "vitest";
import { configSemanticValue, vaultSemanticValue } from "../../core/semantic-value";

describe("domain semantic values", () => {
  it("folds Vault puts by Blob hash and all deletes together", () => {
    expect(vaultSemanticValue({ path: "a", kind: "put", blob: { hash: "a".repeat(64), size: 1 }, parents: [] })).toBe(`vault:blob:${"a".repeat(64)}`);
    expect(vaultSemanticValue({ path: "a", kind: "delete", parents: [] })).toBe("vault:delete");
  });
  it("folds Config snapshots only by ConfigTree hash", () => {
    expect(configSemanticValue({ key: "portable", kind: "snapshot", treeHash: "b".repeat(64), parents: [] })).toBe(`config:tree:${"b".repeat(64)}`);
  });
});
