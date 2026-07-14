import { describe, expect, it } from "vitest";
import { InMemoryRepositoryCore } from "../../core/repository";
import type { RegisterVersion } from "../../core/register";

describe("conflict resolution concurrency", () => {
  const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
  const versionId = (digit: string) => `${digit.repeat(64)}:0:0`;
  const version = (
    id: string,
    parents: string[],
    hash?: string,
  ): RegisterVersion => ({
    repositoryId,
    channel: "vault",
    logicalKey: "a.md",
    versionId: id,
    parents,
    ...(hash ? { blob: { hash, size: 1 } } : {}),
  });

  it("gives every fresh client the same complete conflict independent of delivery order", () => {
    const versions = [
      version(versionId("1"), [], "a".repeat(64)),
      version(versionId("2"), [], "b".repeat(64)),
      version(versionId("3"), [versionId("1"), versionId("2")], "c".repeat(64)),
      version(versionId("4"), [versionId("1"), versionId("2")]),
    ];
    const clients = [versions, [...versions].reverse(), [versions[2], versions[0], versions[3], versions[1]]]
      .map((delivery) => {
        const repository = new InMemoryRepositoryCore();
        for (const item of delivery) repository.ingest(item);
        return repository;
      });
    const expectedHeads = [versionId("3"), versionId("4")];
    for (const client of clients) {
      expect(client.register(repositoryId, "vault", "a.md")).toMatchObject({
        disposition: "concurrent",
        heads: expectedHeads,
      });
      expect(expectedHeads.map((head) => client.version(head)?.blob?.hash ?? "delete")).toEqual(["c".repeat(64), "delete"]);
    }
  });

  it("keeps an unseen concurrent root as a new conflict after a resolution publishes", () => {
    const first = version(versionId("1"), [], "a".repeat(64));
    const second = version(versionId("2"), [], "b".repeat(64));
    const resolution = version(versionId("3"), [first.versionId, second.versionId], "c".repeat(64));
    const unseen = version(versionId("4"), [], "d".repeat(64));
    const repository = new InMemoryRepositoryCore();
    for (const item of [first, second, resolution]) repository.ingest(item);
    expect(repository.register(repositoryId, "vault", "a.md").heads).toEqual([resolution.versionId]);
    repository.ingest(unseen);
    expect(repository.register(repositoryId, "vault", "a.md")).toMatchObject({
      disposition: "concurrent",
      heads: [resolution.versionId, unseen.versionId],
    });
  });
});
