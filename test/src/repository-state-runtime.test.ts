import { describe, expect, it } from "vitest";
import type { LocalStatePathAdapter } from "../../core/local-state-files";
import { createPersistedRepositoryBinding } from "../../core/repository-binding";
import { createRepositoryLocator } from "../../core/locator";
import { createDefaultData } from "../../src/defaults";
import { RepositoryStateRuntime } from "../../src/repository-state-runtime";

class MemoryPaths implements LocalStatePathAdapter {
  readonly entries = new Map<string, { type: "file" | "folder"; source?: string }>([[".obsidian", { type: "folder" }]]);
  failStateRead = false;
  renameCalls = 0;

  async exists(path: string): Promise<boolean> { return this.entries.has(path); }
  async stat(path: string): Promise<{ type: "file" | "folder" } | null> { return this.entries.get(path) ?? null; }
  async mkdir(path: string): Promise<void> {
    if (this.entries.has(path)) throw new Error("exists");
    this.entries.set(path, { type: "folder" });
  }
  async read(path: string): Promise<string> {
    if (this.failStateRead && /state-[ab]\.json$/.test(path)) throw new Error("injected read failure");
    const entry = this.entries.get(path);
    if (entry?.type !== "file") throw new Error("not a file");
    return entry.source!;
  }
  async write(path: string, source: string): Promise<void> {
    this.entries.set(path, { type: "file", source });
  }
  async rename(path: string, newPath: string): Promise<void> {
    this.renameCalls += 1;
    const entry = this.entries.get(path);
    if (!entry || this.entries.has(newPath)) throw new Error("rename refused");
    this.entries.delete(path);
    this.entries.set(newPath, entry);
  }
}

const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
const descriptorHash = "a".repeat(64);

function boundData() {
  const data = createDefaultData();
  const locator = createRepositoryLocator({
    endpoint: "https://s3.example.com",
    region: "test",
    bucket: "vault",
    forcePathStyle: true,
    prefix: "team",
  });
  data.v1 = {
    ...createPersistedRepositoryBinding(locator, repositoryId, descriptorHash, ".obsidian", []),
    writerFrontiers: {},
    writerId: "123e4567-e89b-42d3-a456-426614174001",
    nextSequence: "00000000000000000001",
    previousCommitHash: null,
  };
  return data;
}

describe("repository state runtime", () => {
  it("restores the one supported runtime schema without default-merging causal fields", async () => {
    const paths = new MemoryPaths();
    const first = boundData();
    first.v1VaultGenerations["a.md"] = 3;
    first.v1ProjectedHeads["a.md"] = [];
    await new RepositoryStateRuntime(paths, ".obsidian").persist(first);

    const restored = boundData();
    restored.v1!.writerId = "123e4567-e89b-42d3-a456-426614174099";
    const result = await new RepositoryStateRuntime(paths, ".obsidian").restore(restored);

    expect(result.status).toBe("restored");
    expect(restored.v1?.writerId).toBe(first.v1?.writerId);
    expect(restored.v1VaultGenerations).toEqual({ "a.md": 3 });
  });

  it("restores ingested and observed state while one path remains pending across restart", async () => {
    const paths = new MemoryPaths();
    const first = boundData();
    const commitHash = "b".repeat(64);
    first.v1SparseSeenCommits[commitHash] = {
      key: "team/commit.json",
      writerId: "123e4567-e89b-42d3-a456-426614174001",
      sequence: "00000000000000000001",
      hash: commitHash,
      previousCommitHash: null,
    };
    first.v1ObservedRegisters["vault:a.md"] = {
      key: "vault:a.md",
      heads: [commitHash],
      pending: ["c".repeat(64)],
      invalid: [],
      disposition: "pending",
    };
    first.v1PendingApply["a.md"] = { targetHeads: [commitHash], targetValueHash: "d".repeat(64) };
    await new RepositoryStateRuntime(paths, ".obsidian").persist(first);

    const restored = boundData();
    await new RepositoryStateRuntime(paths, ".obsidian").restore(restored);

    expect(restored.v1SparseSeenCommits).toEqual(first.v1SparseSeenCommits);
    expect(restored.v1ObservedRegisters).toEqual(first.v1ObservedRegisters);
    expect(restored.v1PendingApply).toEqual(first.v1PendingApply);
  });

  it("archives invalid state copies and preserves staging before initializing a new writer state", async () => {
    const paths = new MemoryPaths();
    const data = boundData();
    const runtime = new RepositoryStateRuntime(paths, ".obsidian", () => "invalid-state-test");
    await runtime.persist(data);
    const root = `.obsidian/.obsidian-s3-sync-local/${repositoryId}`;
    paths.entries.set(`${root}/state-a.json`, { type: "file", source: "corrupt" });
    paths.entries.set(`${root}/staged/blob`, { type: "file", source: "staged" });

    const result = await new RepositoryStateRuntime(paths, ".obsidian", () => "invalid-state-test").restore(data);

    expect(result).toMatchObject({ status: "archived-and-reset", archivedCopies: 1 });
    expect(paths.entries.get(`${root}/recovery/invalid-state-test-state-a.json`)?.source).toBe("corrupt");
    expect(paths.entries.get(`${root}/staged/blob`)?.source).toBe("staged");
    expect(paths.entries.has(`${root}/state-a.json`)).toBe(true);
  });

  it("does not archive transient read or permission failures", async () => {
    const paths = new MemoryPaths();
    const data = boundData();
    await new RepositoryStateRuntime(paths, ".obsidian").persist(data);
    paths.failStateRead = true;

    await expect(new RepositoryStateRuntime(paths, ".obsidian").restore(data)).rejects.toThrow("injected read failure");
    expect(paths.renameCalls).toBe(0);
  });
});
