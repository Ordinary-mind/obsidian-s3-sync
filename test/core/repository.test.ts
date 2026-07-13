import { describe, expect, it } from "vitest";
import { InMemoryRepositoryCore } from "../../core/repository";
import { InMemoryRepositoryCore as PublicRepositoryCore } from "../../core";

describe("v1 in-memory repository core", () => {
  it("exports the usable core facade from one entry point", () => {
    expect(PublicRepositoryCore).toBe(InMemoryRepositoryCore);
  });
  it("ingests out-of-order versions and exposes pending, heads and conflicts by register", () => {
    const repository = new InMemoryRepositoryCore();
    repository.ingest({ repositoryId: "repo", channel: "vault", logicalKey: "notes/a.md", versionId: "child", parents: ["root"] });
    expect(repository.register("repo", "vault", "notes/a.md")).toMatchObject({ pending: ["child"], disposition: "pending" });
    repository.ingest({ repositoryId: "repo", channel: "vault", logicalKey: "notes/a.md", versionId: "root", parents: [] });
    repository.ingest({ repositoryId: "repo", channel: "vault", logicalKey: "notes/a.md", versionId: "peer", parents: ["root"] });
    expect(repository.register("repo", "vault", "notes/a.md")).toMatchObject({ heads: ["child", "peer"], disposition: "concurrent" });
    repository.ingest({ repositoryId: "repo", channel: "config", logicalKey: "portable", versionId: "tree", parents: [], configTree: { items: [] } });
    expect(repository.allRegisters("repo").get("config:portable")?.heads).toEqual(["tree"]);
    expect(repository.beginResolution("repo", "vault", "notes/a.md", "merged").parents).toEqual(["child", "peer"]);
    const restored = new InMemoryRepositoryCore();
    restored.restoreVersions(repository.snapshotVersions());
    expect(restored.register("repo", "vault", "notes/a.md").heads).toEqual(["child", "peer"]);
  });
});
