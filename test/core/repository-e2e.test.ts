import { describe, expect, it } from "vitest";
import { InMemoryRepositoryCore } from "../../core/repository";

describe("repository identity isolation", () => {
  it("isolates repository identities sharing one object listing", () => {
    const repositoryA = "123e4567-e89b-42d3-a456-426614174000";
    const repositoryB = "123e4567-e89b-42d3-a456-426614174010";
    const repository = new InMemoryRepositoryCore();
    repository.ingest({
      repositoryId: repositoryA,
      channel: "vault",
      logicalKey: "notes/a.md",
      versionId: "version-a",
      parents: [],
      blob: { hash: "a".repeat(64), size: 1 },
    });
    repository.ingest({
      repositoryId: repositoryB,
      channel: "vault",
      logicalKey: "notes/a.md",
      versionId: "version-b",
      parents: [],
      blob: { hash: "b".repeat(64), size: 1 },
    });

    expect(repository.register(repositoryA, "vault", "notes/a.md").heads).toEqual(["version-a"]);
    expect(repository.register(repositoryB, "vault", "notes/a.md").heads).toEqual(["version-b"]);
    expect(repository.allRegisters(repositoryA).get("vault:notes/a.md")?.heads).not.toContain("version-b");
  });
});
