import { describe, expect, it } from "vitest";
import type { DataAdapter } from "obsidian";
import { ObsidianContentStagingAdapter } from "../../adapters/obsidian-content-staging-adapter";
import { ImmutableContentStaging } from "../../core/content-staging";

class MemoryDataAdapter {
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set<string>([".obsidian/.obsidian-s3-sync/repository"]);

  async exists(path: string) { return this.files.has(path) || this.directories.has(path); }
  async stat(path: string) {
    if (this.files.has(path)) return { type: "file" as const, ctime: 0, mtime: 0, size: this.files.get(path)!.byteLength };
    if (this.directories.has(path)) return { type: "folder" as const, ctime: 0, mtime: 0, size: 0 };
    return null;
  }
  async mkdir(path: string) { this.directories.add(path); }
  async writeBinary(path: string, value: ArrayBuffer) { this.files.set(path, new Uint8Array(value.slice(0))); }
  async readBinary(path: string) {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error("missing");
    return new Uint8Array(bytes).buffer;
  }
  async copy(source: string, target: string) {
    if (await this.exists(target)) throw new Error("exists");
    const bytes = this.files.get(source);
    if (!bytes) throw new Error("missing");
    this.files.set(target, new Uint8Array(bytes));
  }
  async remove(path: string) { this.files.delete(path); }
}

describe("Obsidian content staging adapter", () => {
  it("installs immutable content through DataAdapter copy and verifies duplicate staging", async () => {
    const adapter = new MemoryDataAdapter();
    const staging = new ImmutableContentStaging(new ObsidianContentStagingAdapter(
      adapter as unknown as DataAdapter,
      ".obsidian/.obsidian-s3-sync/repository",
    ));
    const first = await staging.stage(stream(new Uint8Array([1, 2, 3])));
    const second = await staging.stage(stream(new Uint8Array([1, 2, 3])));
    expect(second).toEqual(first);
    await expect(staging.verify(first)).resolves.toBeUndefined();
    expect(await read(await staging.read(first.ref))).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("rejects references outside the repository staging area", async () => {
    const adapter = new MemoryDataAdapter();
    const staging = new ImmutableContentStaging(new ObsidianContentStagingAdapter(
      adapter as unknown as DataAdapter,
      ".obsidian/.obsidian-s3-sync/repository",
    ));
    await expect(staging.read("../state-a.json")).rejects.toThrow();
  });
});

async function* stream(bytes: Uint8Array): AsyncIterable<Uint8Array> { yield bytes; }

async function read(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const values: number[] = [];
  for await (const chunk of chunks) values.push(...chunk);
  return new Uint8Array(values);
}
