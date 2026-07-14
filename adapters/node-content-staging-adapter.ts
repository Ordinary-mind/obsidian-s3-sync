import { createReadStream } from "node:fs";
import { link, mkdir, open, statfs, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ContentStagingAdapter, ContentStagingWriter } from "../core/content-staging";

export class NodeContentStagingAdapter implements ContentStagingAdapter {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async ensureDirectory(path: string): Promise<void> {
    await mkdir(this.resolveRef(path), { recursive: true });
  }

  async createTemporary(ref: string): Promise<ContentStagingWriter> {
    const path = this.resolveRef(ref);
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "wx");
    return new NodeStagingWriter(handle, path);
  }

  async read(ref: string): Promise<AsyncIterable<Uint8Array>> {
    return createReadStream(this.resolveRef(ref));
  }

  async installNoClobber(temporaryRef: string, contentRef: string): Promise<boolean> {
    const temporary = this.resolveRef(temporaryRef);
    const content = this.resolveRef(contentRef);
    await mkdir(dirname(content), { recursive: true });
    try {
      await link(temporary, content);
    } catch (error) {
      if (hasCode(error, "EEXIST")) return false;
      throw error;
    }
    await unlink(temporary);
    return true;
  }

  async remove(ref: string): Promise<void> {
    try { await unlink(this.resolveRef(ref)); }
    catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  }

  async availableBytes(): Promise<number> {
    await mkdir(this.root, { recursive: true });
    const stats = await statfs(this.root, { bigint: true });
    const available = stats.bavail * stats.bsize;
    return available > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(available);
  }

  private resolveRef(ref: string): string {
    if (ref.includes("\\") || ref.startsWith("/") || /^[A-Za-z]:/.test(ref)) throw new Error("staging reference must be relative");
    const segments = ref.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..") || segments[0] !== "staged") {
      throw new Error("staging reference is invalid");
    }
    const absolute = resolve(this.root, ref);
    const child = relative(this.root, absolute);
    if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("staging reference escapes its root");
    return absolute;
  }
}

class NodeStagingWriter implements ContentStagingWriter {
  private closed = false;

  constructor(private readonly handle: FileHandle, private readonly path: string) {}

  async write(chunk: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("staging writer is closed");
    let offset = 0;
    while (offset < chunk.byteLength) {
      const result = await this.handle.write(chunk, offset, chunk.byteLength - offset);
      if (result.bytesWritten <= 0) throw new Error("staging write made no progress");
      offset += result.bytesWritten;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.handle.sync();
    await this.handle.close();
    this.closed = true;
  }

  async abort(): Promise<void> {
    if (!this.closed) {
      await this.handle.close();
      this.closed = true;
    }
    try { await unlink(this.path); }
    catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  }
}

function hasCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code;
}
