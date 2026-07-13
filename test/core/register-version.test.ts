import { describe, expect, it } from "vitest";
import { configRegisterVersion, vaultRegisterVersion } from "../../core/register-version";

describe("register version builders", () => {
  it("uses each Vault path as its logical register", () => {
    expect(vaultRegisterVersion("repo", "v", { path: "notes/a.md", kind: "delete", parents: ["parent"] })).toEqual({ repositoryId: "repo", channel: "vault", logicalKey: "notes/a.md", versionId: "v", parents: ["parent"] });
  });
  it("uses one portable register for every Config snapshot", () => {
    const version = configRegisterVersion("repo", "v", { key: "portable", kind: "snapshot", treeHash: "a".repeat(64), parents: [] }, { items: [] });
    expect(version.logicalKey).toBe("portable");
    expect(version.configTree).toEqual({ items: [] });
  });
});
