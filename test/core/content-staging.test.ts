import { describe, expect, it } from "vitest";
import {
  ContentStagingIntegrityError,
  ContentStagingSpaceError,
  ImmutableContentStaging,
  contentStagingRef,
  type ContentStagingAdapter,
  type ContentStagingWriter,
} from "../../core/content-staging";

class MemoryContentAdapter implements ContentStagingAdapter {
  readonly objects = new Map<string, Uint8Array[]>();
  readonly directories = new Set<string>();
  aborted = 0;
  removed = 0;
  freeBytes: number | undefined;
  corruptInstall = false;
  failAfterWrites: number | undefined;

  async ensureDirectory(path: string): Promise<void> { this.directories.add(path); }

  async createTemporary(ref: string): Promise<ContentStagingWriter> {
    if (this.objects.has(ref)) throw new Error("temporary ref exists");
    const chunks: Uint8Array[] = [];
    let writes = 0;
    return {
      write: async (chunk) => {
        writes += 1;
        if (this.failAfterWrites !== undefined && writes > this.failAfterWrites) throw new Error("injected write failure");
        chunks.push(new Uint8Array(chunk));
      },
      close: async () => { this.objects.set(ref, chunks); },
      abort: async () => { this.aborted += 1; },
    };
  }

  async read(ref: string): Promise<AsyncIterable<Uint8Array>> {
    const chunks = this.objects.get(ref);
    if (!chunks) throw new Error(`missing content: ${ref}`);
    return stream(...chunks);
  }

  async installNoClobber(temporaryRef: string, contentRef: string): Promise<boolean> {
    if (this.objects.has(contentRef)) return false;
    const chunks = this.objects.get(temporaryRef);
    if (!chunks) throw new Error("missing temporary content");
    this.objects.delete(temporaryRef);
    this.objects.set(contentRef, chunks);
    if (this.corruptInstall && chunks[0]) chunks[0][0] ^= 0xff;
    return true;
  }

  async remove(ref: string): Promise<void> { this.objects.delete(ref); this.removed += 1; }
  async availableBytes(): Promise<number | undefined> { return this.freeBytes; }
}

describe("immutable content staging", () => {
  it("streams bytes into a hash-addressed ref and verifies installed content", async () => {
    const adapter = new MemoryContentAdapter();
    const staging = new ImmutableContentStaging(adapter);
    const result = await staging.stage(stream(new Uint8Array([1]), new Uint8Array([2, 3])));

    expect(result).toEqual({
      ref: "staged/sha256/03/039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
      hash: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
      size: 3,
    });
    await expect(staging.verify(result)).resolves.toBeUndefined();
    expect([...adapter.objects.keys()]).toEqual([result.ref]);
  });

  it("treats the same bytes as idempotent and removes the redundant temporary object", async () => {
    const adapter = new MemoryContentAdapter();
    const staging = new ImmutableContentStaging(adapter);
    const first = await staging.stage(stream(new TextEncoder().encode("same")));
    const second = await staging.stage(stream(new TextEncoder().encode("same")));
    expect(second).toEqual(first);
    expect(adapter.removed).toBe(1);
    expect([...adapter.objects.keys()]).toEqual([first.ref]);
  });

  it("rejects an existing different body at the same hash ref", async () => {
    const adapter = new MemoryContentAdapter();
    const bytes = new TextEncoder().encode("expected");
    const expected = await new ImmutableContentStaging(adapter).stage(stream(bytes));
    adapter.objects.set(expected.ref, [new TextEncoder().encode("collision")]);

    await expect(new ImmutableContentStaging(adapter).stage(stream(bytes))).rejects.toBeInstanceOf(ContentStagingIntegrityError);
    expect(adapter.removed).toBe(1);
  });

  it("does not expose formal content after a write or install verification failure", async () => {
    const writeFailure = new MemoryContentAdapter();
    writeFailure.failAfterWrites = 1;
    await expect(new ImmutableContentStaging(writeFailure).stage(stream(new Uint8Array([1]), new Uint8Array([2])))).rejects.toThrow("injected");
    expect(writeFailure.aborted).toBe(1);
    expect([...writeFailure.objects.keys()].some((ref) => ref.startsWith("staged/sha256/"))).toBe(false);

    const corruptInstall = new MemoryContentAdapter();
    corruptInstall.corruptInstall = true;
    await expect(new ImmutableContentStaging(corruptInstall).stage(stream(new Uint8Array([1])))).rejects.toBeInstanceOf(ContentStagingIntegrityError);
    expect([...corruptInstall.objects.keys()].some((ref) => ref.startsWith("staged/sha256/"))).toBe(false);
  });

  it("checks a size estimate before creating temporary content", async () => {
    const adapter = new MemoryContentAdapter();
    adapter.freeBytes = 4;
    await expect(new ImmutableContentStaging(adapter).stage(stream(new Uint8Array(5)), 5)).rejects.toEqual(new ContentStagingSpaceError(5, 4));
    expect(adapter.objects.size).toBe(0);
  });

  it("rejects malformed content refs", () => {
    expect(() => contentStagingRef("ABC")).toThrow("hash is invalid");
  });
});

async function* stream(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}
