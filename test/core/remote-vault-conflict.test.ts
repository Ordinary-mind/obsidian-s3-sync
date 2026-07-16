import { describe, expect, it } from "vitest";
import { InMemoryRepositoryCore } from "../../core/repository";
import { inspectRemoteVaultRegister, listRemoteVaultConflicts } from "../../core/remote-vault-conflict";
import type { RegisterVersion } from "../../core/register";

describe("remote Vault conflict candidates", () => {
  const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
  const versionId = (digit: string) => `${digit.repeat(64)}:0:0`;

  it("returns stable put and delete candidates for every concurrent head", () => {
    const repository = new InMemoryRepositoryCore();
    repository.ingest(version("b.md", versionId("2")));
    repository.ingest(version("a.md", versionId("3"), "c".repeat(64), 3));
    repository.ingest(version("a.md", versionId("1"), "a".repeat(64), 1));

    expect(listRemoteVaultConflicts(repository, repositoryId)).toEqual([
      {
        path: "a.md",
        disposition: "concurrent",
        heads: [versionId("1"), versionId("3")],
        candidates: [
          { kind: "put", versionId: versionId("1"), hash: "a".repeat(64), size: 1 },
          { kind: "put", versionId: versionId("3"), hash: "c".repeat(64), size: 3 },
        ],
      },
    ]);

    repository.ingest(version("b.md", versionId("4"), "d".repeat(64), 4));
    expect(inspectRemoteVaultRegister(repository, repositoryId, "b.md").candidates).toEqual([
      { kind: "delete", versionId: versionId("2") },
      { kind: "put", versionId: versionId("4"), hash: "d".repeat(64), size: 4 },
    ]);
  });

  function version(path: string, id: string, hash?: string, size = 0): RegisterVersion {
    return {
      repositoryId,
      channel: "vault",
      logicalKey: path,
      versionId: id,
      parents: [],
      ...(hash ? { blob: { hash, size } } : {}),
    };
  }
});
