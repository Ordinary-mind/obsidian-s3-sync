import { describe, expect, it } from "vitest";
import { openRepositoryStateFiles, type LocalStatePathAdapter } from "../../core/local-state-files";
import { DurableStateStore } from "../../core/durable-state";

class MemoryPaths implements LocalStatePathAdapter {
  readonly entries = new Map<string, { type: "file" | "folder"; source?: string }>([[".obsidian", { type: "folder" }]]);
  async exists(path: string): Promise<boolean> { return this.entries.has(path); }
  async stat(path: string): Promise<{ type: "file" | "folder" } | null> { return this.entries.get(path) ?? null; }
  async mkdir(path: string): Promise<void> { if (this.entries.has(path)) throw new Error("exists"); this.entries.set(path, { type: "folder" }); }
  async read(path: string): Promise<string> { const entry = this.entries.get(path); if (entry?.type !== "file") throw new Error("not a file"); return entry.source!; }
  async write(path: string, source: string): Promise<void> { this.entries.set(path, { type: "file", source }); }
}

describe("repository local state files", () => {
  const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
  const root = `.obsidian/.obsidian-s3-sync-local/${repositoryId}`;

  it("creates the fixed owned root and hosts dual-copy state", async () => {
    const paths = new MemoryPaths();
    const store = new DurableStateStore<{ ready: boolean }>(await openRepositoryStateFiles(paths, ".obsidian", repositoryId));
    await store.update(() => ({ ready: true }));
    expect(paths.entries.get(`${root}/owner.json`)?.source).toContain(repositoryId);
    expect(paths.entries.has(`${root}/state-a.json`)).toBe(true);
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
});
