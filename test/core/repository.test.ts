import { describe, expect, it } from "vitest";
import { InMemoryRepositoryCore } from "../../core/repository";
import { InMemoryRepositoryCore as PublicRepositoryCore } from "../../core";
import { configRegisterVersion, vaultRegisterVersion } from "../../core/register-version";
import { buildResolutionMutation } from "../../core/resolution-builder";

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

  it("keeps Vault put/put, put/delete and multi-writer changes concurrent", () => {
    const root = vaultRegisterVersion("repo", "root", { path: "notes/a.md", kind: "put", blob: { hash: "a".repeat(64), size: 1 }, parents: [] });
    const cases = [
      [
        vaultRegisterVersion("repo", "put-a", { path: "notes/a.md", kind: "put", blob: { hash: "b".repeat(64), size: 1 }, parents: ["root"] }),
        vaultRegisterVersion("repo", "put-b", { path: "notes/a.md", kind: "put", blob: { hash: "c".repeat(64), size: 1 }, parents: ["root"] }),
      ],
      [
        vaultRegisterVersion("repo", "put", { path: "notes/a.md", kind: "put", blob: { hash: "b".repeat(64), size: 1 }, parents: ["root"] }),
        vaultRegisterVersion("repo", "delete", { path: "notes/a.md", kind: "delete", parents: ["root"] }),
      ],
      [
        vaultRegisterVersion("repo", "writer-a", { path: "notes/a.md", kind: "put", blob: { hash: "b".repeat(64), size: 1 }, parents: ["root"] }),
        vaultRegisterVersion("repo", "writer-b", { path: "notes/a.md", kind: "put", blob: { hash: "c".repeat(64), size: 1 }, parents: ["root"] }),
        vaultRegisterVersion("repo", "writer-c", { path: "notes/a.md", kind: "delete", parents: ["root"] }),
      ],
    ];
    for (const peers of cases) {
      const repository = new InMemoryRepositoryCore();
      repository.ingest(root);
      peers.forEach((peer) => repository.ingest(peer));
      expect(repository.register("repo", "vault", "notes/a.md")).toMatchObject({ heads: peers.map((peer) => peer.versionId).sort(), disposition: "concurrent" });
    }
  });

  it("keeps concurrent ConfigTrees separate and expires a stale resolution", () => {
    const repository = new InMemoryRepositoryCore();
    const tree = (path: string) => ({ items: [{ path, kind: "put" as const }] });
    const root = configRegisterVersion("repo", "root", { key: "portable", kind: "snapshot", treeHash: "a".repeat(64), parents: [] }, tree("app.json"));
    const first = configRegisterVersion("repo", "first", { key: "portable", kind: "snapshot", treeHash: "b".repeat(64), parents: ["root"] }, tree("themes/first.css"));
    const second = configRegisterVersion("repo", "second", { key: "portable", kind: "snapshot", treeHash: "c".repeat(64), parents: ["root"] }, tree("themes/second.css"));
    repository.ingest(root);
    repository.ingest(first);
    repository.ingest(second);
    expect(repository.register("repo", "config", "portable")).toMatchObject({ heads: ["first", "second"], disposition: "concurrent" });
    const intent = repository.beginResolution("repo", "config", "portable", "d".repeat(64));
    repository.ingest(configRegisterVersion("repo", "later", { key: "portable", kind: "snapshot", treeHash: "e".repeat(64), parents: ["root"] }, tree("themes/later.css")));
    expect(() => buildResolutionMutation(intent, repository.register("repo", "config", "portable").heads)).toThrow("conflict set changed");
  });
});
