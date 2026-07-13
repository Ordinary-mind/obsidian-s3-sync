import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ChunkStagingArea {
  write(index: number, bytes: Uint8Array): Promise<void>;
  read(index: number): Promise<Uint8Array>;
  dispose(): Promise<void>;
}

export async function createDiskChunkStagingArea(): Promise<ChunkStagingArea> {
  const directory = await mkdtemp(join(tmpdir(), "obsidian-s3-sync-envelope-"));
  const pathFor = (index: number) => join(directory, `${index.toString().padStart(4, "0")}.json`);
  return {
    write: async (index, bytes) => { await writeFile(pathFor(index), bytes); },
    read: async (index) => new Uint8Array(await readFile(pathFor(index))),
    dispose: async () => { await rm(directory, { recursive: true, force: true }); },
  };
}
