import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeContentStagingAdapter } from "../../adapters/node-content-staging-adapter";
import { ImmutableContentStaging } from "../../core/content-staging";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("node content staging adapter", () => {
  it("installs immutable content by hash and deduplicates an identical second stage", async () => {
    const root = await createTemporaryRoot();
    const staging = new ImmutableContentStaging(new NodeContentStagingAdapter(root));
    const bytes = new TextEncoder().encode("verified config bytes");

    const first = await staging.stage(chunks(bytes.subarray(0, 8), bytes.subarray(8)), bytes.byteLength);
    const second = await staging.stage(chunks(bytes), bytes.byteLength);

    expect(second).toEqual(first);
    expect(await readFile(join(root, ...first.ref.split("/")))).toEqual(Buffer.from(bytes));
    expect(await readdir(join(root, "staged", "tmp"))).toEqual([]);
    await expect(staging.verify(first)).resolves.toBeUndefined();
  });

  it("removes aborted temporary files and rejects references outside the staging namespace", async () => {
    const root = await createTemporaryRoot();
    const adapter = new NodeContentStagingAdapter(root);
    await adapter.ensureDirectory("staged/tmp");
    const writer = await adapter.createTemporary("staged/tmp/aborted");
    await writer.write(new Uint8Array([1, 2, 3]));
    await writer.abort();

    expect(await readdir(join(root, "staged", "tmp"))).toEqual([]);
    await expect(adapter.ensureDirectory("../outside")).rejects.toThrow("invalid");
    await expect(adapter.createTemporary("staged/../outside")).rejects.toThrow("invalid");
    await expect(adapter.read("/absolute")).rejects.toThrow("relative");
  });
});

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "obsidian-s3-sync-staging-"));
  temporaryRoots.push(root);
  return root;
}

async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield new Uint8Array(value);
}
