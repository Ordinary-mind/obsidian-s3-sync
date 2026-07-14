import { describe, expect, it } from "vitest";
import {
  openRepositoryStateFiles,
  recoverResidualRepositoryDirectories,
  scanResidualRepositoryStateRoots,
  type LocalStatePathAdapter,
} from "../../core/local-state-files";
import { DurableStateStore, type StateJsonValue } from "../../core/durable-state";
import { repositoryDurablePayload } from "../../core/repository-durable-payload";
import { repositoryFingerprint, type RepositoryLocator } from "../../core/locator";

class MemoryPaths implements LocalStatePathAdapter {
  readonly entries = new Map<string, { type: "file" | "folder"; source?: string }>([[".obsidian", { type: "folder" }]]);
  mkdirCalls = 0;
  writeCalls = 0;
  async exists(path: string): Promise<boolean> { return this.entries.has(path); }
  async stat(path: string): Promise<{ type: "file" | "folder" } | null> { return this.entries.get(path) ?? null; }
  async mkdir(path: string): Promise<void> { this.mkdirCalls += 1; if (this.entries.has(path)) throw new Error("exists"); this.entries.set(path, { type: "folder" }); }
  async read(path: string): Promise<string> { const entry = this.entries.get(path); if (entry?.type !== "file") throw new Error("not a file"); return entry.source!; }
  async write(path: string, source: string): Promise<void> { this.writeCalls += 1; this.entries.set(path, { type: "file", source }); }
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

  it("recovers directory history from verified durable state without modifying residual roots", async () => {
    const paths = new MemoryPaths();
    const validFiles = await openRepositoryStateFiles(paths, ".obsidian", repositoryId);
    const locator: RepositoryLocator = {
      endpoint: "https://s3.example.com",
      region: "test",
      bucket: "vault",
      forcePathStyle: true,
      normalizedPrefix: "team",
    };
    const descriptorHash = "a".repeat(64);
    await new DurableStateStore<StateJsonValue>(validFiles).update(() => repositoryDurablePayload({
      repositoryId,
      descriptorHash,
      repositoryFingerprint: repositoryFingerprint(locator, repositoryId, descriptorHash),
      locator,
      configDir: ".obsidian",
      historicalConfigDirs: [".old", ".legacy"],
      writerId: "123e4567-e89b-42d3-a456-426614174099",
      nextSequence: "00000000000000000001",
      previousCommitHash: null,
      writerFrontiers: {},
    }));
    paths.entries.set(`${root}/state-b.json`, { type: "file", source: "corrupt-copy" });

    const missingId = "123e4567-e89b-42d3-a456-426614174001";
    await openRepositoryStateFiles(paths, ".obsidian", missingId);
    const corruptId = "123e4567-e89b-42d3-a456-426614174002";
    await openRepositoryStateFiles(paths, ".obsidian", corruptId);
    paths.entries.set(`.obsidian/.obsidian-s3-sync-local/${corruptId}/state-a.json`, { type: "file", source: "corrupt" });
    paths.entries.set(".obsidian/.obsidian-s3-sync-local/not-owned", { type: "folder" });

    const callsBefore = { mkdir: paths.mkdirCalls, write: paths.writeCalls };
    const recovery = await recoverResidualRepositoryDirectories(paths, ".obsidian");

    expect(recovery.recovered).toEqual([expect.objectContaining({
      repositoryId,
      configDir: ".obsidian",
      historicalConfigDirs: [".old", ".legacy"],
    })]);
    expect(recovery.historicalConfigDirCandidates).toEqual([".legacy", ".obsidian", ".old"]);
    expect(recovery).toMatchObject({
      complete: false,
      issues: expect.arrayContaining([
        { root: `.obsidian/.obsidian-s3-sync-local/${missingId}`, reason: "state-missing" },
        { root: `.obsidian/.obsidian-s3-sync-local/${corruptId}`, reason: "state-invalid" },
        { root: ".obsidian/.obsidian-s3-sync-local/not-owned", reason: "root-refused" },
      ]),
    });
    expect({ mkdir: paths.mkdirCalls, write: paths.writeCalls }).toEqual(callsBefore);
  });
});
