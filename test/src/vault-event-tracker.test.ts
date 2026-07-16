import { describe, expect, it, vi } from "vitest";
import { createRepositoryLocator } from "../../core/locator";
import { createPersistedRepositoryBinding } from "../../core/repository-binding";
import { createDefaultData } from "../../src/defaults";
import { VaultEventTracker } from "../../src/vault-event-tracker";

function harness(managed = true) {
  const data = createDefaultData();
  const locator = createRepositoryLocator({
    endpoint: "https://s3.example.com",
    region: "test",
    bucket: "vault",
    forcePathStyle: true,
    prefix: "team",
  });
  data.v1 = {
    ...createPersistedRepositoryBinding(
      locator,
      "123e4567-e89b-42d3-a456-426614174000",
      "a".repeat(64),
      ".obsidian",
      [],
    ),
    writerFrontiers: {},
    writerId: "123e4567-e89b-42d3-a456-426614174001",
    nextSequence: "00000000000000000001",
    previousCommitHash: null,
  };
  const persistSoon = vi.fn();
  const notifyChange = vi.fn();
  const tracker = new VaultEventTracker({
    getData: () => data,
    isManagedPath: () => managed,
    capturePathHash: vi.fn(async () => ({ hash: "b".repeat(64) })),
    currentApplyOperation: () => undefined,
    persistSoon,
    notifyChange,
  });
  return { data, tracker, persistSoon, notifyChange };
}

describe("vault event tracker", () => {
  it("records an editor generation and persists it once", () => {
    const test = harness();

    test.tracker.recordEditorChange("a.md", "b".repeat(64));

    expect(test.data.v1DirtyIntents["a.md"]).toMatchObject({
      path: "a.md",
      expectedContentHash: "b".repeat(64),
      generation: 1,
    });
    expect(test.persistSoon).toHaveBeenCalledTimes(1);
    expect(test.notifyChange).toHaveBeenCalledTimes(1);
  });

  it("combines a Vault upsert and editor disk observation into one persistence request", async () => {
    const test = harness();
    test.tracker.recordEditorChange("a.md", "b".repeat(64));
    test.persistSoon.mockClear();
    test.notifyChange.mockClear();

    await test.tracker.handleUpsert("a.md");

    expect(test.data.v1VaultEvents).toHaveLength(1);
    expect(test.data.v1DirtyIntents["a.md"].awaitingLocalWrite).toBe(false);
    expect(test.persistSoon).toHaveBeenCalledTimes(1);
    expect(test.notifyChange).toHaveBeenCalledTimes(1);
  });

  it("records both sides of a rename as one causal transaction", () => {
    const test = harness();

    test.tracker.handleRename("old.md", "new.md");

    expect(test.data.v1VaultEvents.map((event) => [event.kind, event.path])).toEqual([
      ["delete", "old.md"],
      ["upsert", "new.md"],
    ]);
    expect(test.data.v1VaultGenerations).toEqual({ "old.md": 1, "new.md": 1 });
    expect(test.persistSoon).toHaveBeenCalledTimes(1);
  });

  it("does not mutate ignored or otherwise unmanaged paths", async () => {
    const test = harness(false);

    test.tracker.recordEditorChange("ignored.md", "b".repeat(64));
    await test.tracker.handleUpsert("ignored.md");
    test.tracker.handleDelete("ignored.md");

    expect(test.data.v1VaultEvents).toEqual([]);
    expect(test.data.v1DirtyIntents).toEqual({});
    expect(test.persistSoon).not.toHaveBeenCalled();
  });
});
