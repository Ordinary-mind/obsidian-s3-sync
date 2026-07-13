import { describe, expect, it } from "vitest";
import { runDesktopRuntimeContract } from "../../src/runtime-contract";
import type { RuntimeContractAdapter } from "../../src/runtime-contract";

class FakeAdapter implements RuntimeContractAdapter {
  private readonly files = new Map<string, string>();
  private readonly directories = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.directories.add(path);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error("not found");
    return value;
  }

  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }

  async rename(from: string, to: string): Promise<void> {
    if (this.files.has(to)) throw new Error("target exists");
    const value = await this.read(from);
    this.files.delete(from);
    this.files.set(to, value);
  }

  async copy(from: string, to: string): Promise<void> {
    if (this.files.has(to)) throw new Error("target exists");
    this.files.set(to, await this.read(from));
  }

  async rmdir(path: string): Promise<void> {
    for (const key of this.files.keys()) if (key.startsWith(`${path}/`)) this.files.delete(key);
    this.directories.delete(path);
  }
}

describe("desktop runtime contract", () => {
  it("validates write/read, rename, and no-clobber copy in an isolated plugin directory", async () => {
    const adapter = new FakeAdapter();
    await expect(runDesktopRuntimeContract(adapter, ".obsidian", "obsidian-s3-sync", "session-one", false, "test-run")).resolves.toEqual({
      configDir: ".obsidian",
      durableWriteReadback: true,
      durableAcrossPluginReload: null,
      editorChangeObserved: false,
      writeReadback: true,
      rename: true,
      renameRejectsExistingTarget: true,
      renameNoClobberPreservesBytes: true,
      copyRejectsExistingTarget: true,
    });
    await expect(runDesktopRuntimeContract(adapter, ".obsidian", "obsidian-s3-sync", "session-two", true, "second-run")).resolves.toMatchObject({
      durableWriteReadback: true,
      durableAcrossPluginReload: true,
      editorChangeObserved: true,
    });
    await expect(adapter.exists(".obsidian/plugins/obsidian-s3-sync/runtime-contract-test-run")).resolves.toBe(false);
  });
});
