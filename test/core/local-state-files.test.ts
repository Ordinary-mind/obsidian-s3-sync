import { describe, expect, it } from "vitest";
import {
  openRepositoryStateFiles,
  scanResidualRepositoryStateRoots,
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
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${path}/`;
    const files: string[] = [];
    const folders: string[] = [];
    for (const [candidate, entry] of this.entries) {
      if (!candidate.startsWith(prefix) || candidate.slice(prefix.length).includes("/")) continue;
      (entry.type === "file" ? files : folders).push(candidate);
    }
    return { files, folders };
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

  it("finds owned residual state after plugin data is lost and refuses unknown roots", async () => {
    const paths = new MemoryPaths();
    await openRepositoryStateFiles(paths, ".obsidian", repositoryId);
    paths.entries.set(".obsidian/.obsidian-s3-sync-local/not-owned", { type: "folder" });
    paths.entries.set(".obsidian/.obsidian-s3-sync-local/orphan.json", { type: "file", source: "{}" });
    const scan = await scanResidualRepositoryStateRoots(paths, ".obsidian");
    expect(scan.ownedRepositoryIds).toEqual([repositoryId]);
    expect(scan.refusedRoots).toEqual([
      ".obsidian/.obsidian-s3-sync-local/not-owned",
      ".obsidian/.obsidian-s3-sync-local/orphan.json",
    ]);
  });
});
