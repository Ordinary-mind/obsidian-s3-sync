import type { DataAdapter } from "obsidian";
import type { ContentStagingAdapter, ContentStagingWriter } from "../core/content-staging";
import { normalizeRepositoryStateReference } from "../core/local-state-layout";
import { normalizeVaultPath } from "../core/path";

export class ObsidianContentStagingAdapter implements ContentStagingAdapter {
  private readonly root: string;

  constructor(private readonly adapter: DataAdapter, root: string) {
    this.root = normalizeVaultPath(root);
  }

  async ensureDirectory(reference: string): Promise<void> {
    const path = this.resolveRef(reference);
    if (!(await this.adapter.exists(path))) await this.adapter.mkdir(path);
    if ((await this.adapter.stat(path))?.type !== "folder") throw new Error("content staging path is not a directory");
  }

  async createTemporary(reference: string): Promise<ContentStagingWriter> {
    const path = this.resolveRef(reference);
    if (await this.adapter.exists(path)) throw new Error("content staging temporary reference already exists");
    return new BufferedStagingWriter(this.adapter, path);
  }

  async read(reference: string): Promise<AsyncIterable<Uint8Array>> {
    const path = this.resolveRef(reference);
    if ((await this.adapter.stat(path))?.type !== "file") throw new Error("content staging reference is not a file");
    const bytes = new Uint8Array(await this.adapter.readBinary(path));
    return oneChunk(bytes);
  }

  async installNoClobber(temporaryRef: string, contentRef: string): Promise<boolean> {
    const temporary = this.resolveRef(temporaryRef);
    const content = this.resolveRef(contentRef);
    try {
      await this.adapter.copy(temporary, content);
    } catch (error) {
      if (await this.adapter.exists(content)) return false;
      throw error;
    }
    await this.adapter.remove(temporary);
    return true;
  }

  async remove(reference: string): Promise<void> {
    const path = this.resolveRef(reference);
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }

  private resolveRef(reference: string): string {
    if (reference === "staged") return `${this.root}/staged`;
    return `${this.root}/${normalizeRepositoryStateReference(reference, ["staged"])}`;
  }
}

class BufferedStagingWriter implements ContentStagingWriter {
  private readonly chunks: Uint8Array[] = [];
  private closed = false;

  constructor(private readonly adapter: DataAdapter, private readonly path: string) {}

  async write(chunk: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("staging writer is closed");
    this.chunks.push(new Uint8Array(chunk));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const size = this.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    if (!Number.isSafeInteger(size)) throw new Error("content staging size exceeds safe integer range");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    await this.adapter.writeBinary(this.path, bytes.buffer);
    this.chunks.length = 0;
  }

  async abort(): Promise<void> {
    this.closed = true;
    this.chunks.length = 0;
    if (await this.adapter.exists(this.path)) await this.adapter.remove(this.path);
  }
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield new Uint8Array(bytes);
}
