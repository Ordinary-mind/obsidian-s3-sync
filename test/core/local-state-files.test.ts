import { describe, expect, it } from "vitest";
import {
  archiveRepositoryStateCopies,
  openRepositoryStateFiles,
  type LocalStatePathAdapter,
} from "../../core/local-state-files";
import { DurableStateStore } from "../../core/durable-state";

class MemoryPaths implements LocalStatePathAdapter {
  readonly entries = new Map<string, { type: "file" | "folder"; source?: string }>([[".obsidian", { type: "folder" }]]);
  async exists(path: string): Promise<boolean> { return this.entries.has(path); }
  async stat(path: string): Promise<{ type: "file" | "folder" } | null> { return this.entries.get(path) ?? null; }
  async mkdir(path: string): Promise<void> { if (this.entries.has(path)) throw new Error("exists"); this.entries.set(path, { type: "folder" }); }
  async read(path: string): Promise<string> { const entry = this.entries.get(path); if (entry?.type !== "file") throw new Error("not a file"); return entry.source!; }
  async write(path: string, source: string): Promise<void> { this.entries.set(path, { type: "file", source }); }
  async rename(path: string, newPath: string): Promise<void> {
    const entry = this.entries.get(path);
    if (!entry || this.entries.has(newPath)) throw new Error("rename refused");
    this.entries.delete(path);
    this.entries.set(newPath, entry);
  }
}

describe("repository local state files", () => {
  const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
  const root = `.obsidian/.obsidian-s3-sync-local/${repositoryId}`;

  it("creates the fixed owned root and hosts dual-copy state", async () => {
    const paths = new MemoryPaths();
    const files = await openRepositoryStateFiles(paths, ".obsidian", repositoryId);
    const store = new DurableStateStore<{ ready: boolean }>(files);
    await store.update(() => ({ ready: true }));
    expect(paths.entries.get(`${root}/owner.json`)?.source).toContain(repositoryId);
    expect(paths.entries.has(`${root}/state-a.json`)).toBe(true);
    for (const area of ["staged", "outbox", "journals", "recovery", "conflict-drafts"]) {
      expect(paths.entries.get(`${root}/${area}`)?.type).toBe("folder");
    }
    expect(files.resolve("recovery/one", ["recovery"])).toBe(`${root}/recovery/one`);
    expect(() => files.resolve("staged/one", ["recovery"])).toThrow("unsupported area");
  });

  it("refuses a file root, missing owner, and owner replacement before writes", async () => {
    const fileRoot = new MemoryPaths();
    fileRoot.entries.set(root, { type: "file", source: "wrong" });
    await expect(openRepositoryStateFiles(fileRoot, ".obsidian", repositoryId)).rejects.toThrow("not a directory");

    const paths = new MemoryPaths();
    const files = await openRepositoryStateFiles(paths, ".obsidian", repositoryId);
    paths.entries.set(`${root}/owner.json`, { type: "file", source: "{}" });
    await expect(files.write("state-a.json", "value")).rejects.toThrow("ownership refused");
  });

  it("archives invalid state copies without deleting staged or recovery content", async () => {
    const paths = new MemoryPaths();
    const files = await openRepositoryStateFiles(paths, ".obsidian", repositoryId);
    await files.write("state-a.json", "invalid-a");
    await files.write("state-b.json", "invalid-b");
    paths.entries.set(`${root}/staged/blob`, { type: "file", source: "staged" });

    const result = await archiveRepositoryStateCopies(paths, ".obsidian", repositoryId, "invalid-state-1");

    expect(result.archived).toEqual([
      `${root}/recovery/invalid-state-1-state-a.json`,
      `${root}/recovery/invalid-state-1-state-b.json`,
    ]);
    expect(paths.entries.get(`${root}/staged/blob`)?.source).toBe("staged");
    expect(paths.entries.has(`${root}/state-a.json`)).toBe(false);
    expect(paths.entries.has(`${root}/state-b.json`)).toBe(false);
  });

});
