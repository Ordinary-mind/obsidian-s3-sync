import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../protocol/hash";
import {
  captureStableStream,
  captureStableStreamHash,
  captureStableStreamToStaging,
  sha256Stream,
  type ContentAddressedStreamStaging,
  type ImmutableStagingArea,
  type ImmutableStagingWriter,
  type StreamReadObservation,
} from "../../core/streaming-capture";

class MemoryStaging implements ImmutableStagingArea {
  readonly objects = new Map<string, Uint8Array[]>();
  aborted = 0;
  removed = 0;
  corruptAfterClose = false;

  async create(): Promise<ImmutableStagingWriter> {
    const ref = `stage-${this.objects.size + 1}`;
    const chunks: Uint8Array[] = [];
    return {
      ref,
      write: async (chunk) => { chunks.push(new Uint8Array(chunk)); },
      close: async () => {
        if (this.corruptAfterClose && chunks[0]) chunks[0][0] ^= 0xff;
        this.objects.set(ref, chunks);
      },
      abort: async () => { this.aborted += 1; },
    };
  }

  async read(ref: string): Promise<AsyncIterable<Uint8Array>> {
    const chunks = this.objects.get(ref);
    if (!chunks) throw new Error(`missing stage: ${ref}`);
    return stream(...chunks);
  }

  async remove(ref: string): Promise<void> {
    this.objects.delete(ref);
    this.removed += 1;
  }
}

class ContentAddressedMemoryStaging implements ContentAddressedStreamStaging {
  readonly contents = new Map<string, Uint8Array>();
  stages = 0;
  verifications = 0;

  async stage(chunks: AsyncIterable<Uint8Array>) {
    this.stages += 1;
    const bytes = await readBytes(chunks);
    const hash = sha256Hex(bytes);
    const ref = `staged/sha256/${hash}`;
    this.contents.set(ref, bytes);
    return { ref, hash, size: bytes.byteLength };
  }

  async verify(ref: string, expected: { hash: string; size: number }): Promise<void> {
    this.verifications += 1;
    const bytes = this.contents.get(ref);
    if (!bytes || bytes.byteLength !== expected.size || sha256Hex(bytes) !== expected.hash) throw new Error("corrupt stage");
  }
}

describe("streaming stable capture", () => {
  it("hashes raw bytes independently of chunk boundaries", async () => {
    const whole = await sha256Stream(stream(new Uint8Array([1, 2, 3, 4])));
    const split = await sha256Stream(stream(new Uint8Array([1]), new Uint8Array([2, 3]), new Uint8Array([4])));
    expect(split).toEqual(whole);
  });

  it("captures zero-byte, Unicode, and multi-chunk content after staged rehash", async () => {
    const staging = new MemoryStaging();
    const bytes = new TextEncoder().encode("笔记/é\n".repeat(1000));
    let quietWindows = 0;
    const result = await captureStableStream({
      read: async () => ({ type: "file", chunks: stream(bytes.subarray(0, 7), bytes.subarray(7)) }),
      staging,
      quietWindow: async () => { quietWindows += 1; },
    });
    expect(result).toMatchObject({ status: "captured", size: bytes.byteLength });
    expect(quietWindows).toBe(1);

    await expect(captureStableStream({
      read: async () => ({ type: "file", chunks: stream() }),
      staging: new MemoryStaging(),
      quietWindow: async () => {},
    })).resolves.toMatchObject({ status: "captured", size: 0, hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" });
  });

  it("captures a large stream without requiring one contiguous source buffer", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x5a);
    const read = async () => ({ type: "file" as const, chunks: repeatedStream(chunk, 8) });
    await expect(captureStableStream({ read, staging: new MemoryStaging(), quietWindow: async () => {} }))
      .resolves.toMatchObject({ status: "captured", size: 8 * 1024 * 1024 });
  });

  it("stages the first stable stream once and returns its content-addressed reference", async () => {
    const staging = new ContentAddressedMemoryStaging();
    const bytes = new TextEncoder().encode("streamed Outbox body");
    const result = await captureStableStreamToStaging({
      read: async () => ({ type: "file", chunks: stream(bytes.subarray(0, 3), bytes.subarray(3)) }),
      staging,
      quietWindow: async () => undefined,
      estimatedBytes: bytes.byteLength,
      maxBytes: 1024,
    });
    expect(result).toMatchObject({ status: "captured", size: bytes.byteLength, stagedRef: expect.stringContaining("staged/sha256/") });
    expect(staging.stages).toBe(1);
    expect(staging.verifications).toBe(1);

    await expect(captureStableStreamToStaging({
      read: async () => ({ type: "file", chunks: stream(bytes) }),
      staging,
      quietWindow: async () => undefined,
      estimatedBytes: 2048,
      maxBytes: 1024,
    })).resolves.toMatchObject({ status: "retry", reason: "too-large" });
    expect(staging.stages).toBe(1);
  });

  it("hashes stable files without retaining their body and detects the second-read change", async () => {
    const observations: StreamReadObservation[] = [
      { type: "file", chunks: stream(new Uint8Array([1, 2])) },
      { type: "file", chunks: stream(new Uint8Array([1, 3])) },
    ];
    await expect(captureStableStreamHash({
      read: async () => observations.shift()!,
      quietWindow: async () => undefined,
    })).resolves.toEqual({ status: "retry", reason: "changed" });
  });

  it("retries when bytes or node type change between reads", async () => {
    const observations: StreamReadObservation[] = [
      { type: "file", chunks: stream(new Uint8Array([1])) },
      { type: "file", chunks: stream(new Uint8Array([2])) },
    ];
    const staging = new MemoryStaging();
    await expect(captureStableStream({ read: async () => observations.shift()!, staging, quietWindow: async () => {} }))
      .resolves.toEqual({ status: "retry", reason: "changed" });
    expect(staging.removed).toBe(1);

    const types: StreamReadObservation[] = [{ type: "file", chunks: stream(new Uint8Array([1])) }, { type: "other" }];
    await expect(captureStableStream({ read: async () => types.shift()!, staging: new MemoryStaging(), quietWindow: async () => {} }))
      .resolves.toEqual({ status: "retry", reason: "changed" });
  });

  it("rejects corrupt staging, size overflow, and read failures", async () => {
    const corrupt = new MemoryStaging();
    corrupt.corruptAfterClose = true;
    await expect(captureStableStream({ read: async () => ({ type: "file", chunks: stream(new Uint8Array([1])) }), staging: corrupt, quietWindow: async () => {} }))
      .resolves.toEqual({ status: "retry", reason: "stage-corrupt" });

    const limited = await captureStableStream({
      read: async () => ({ type: "file", chunks: stream(new Uint8Array(1024), new Uint8Array(1024)) }),
      staging: new MemoryStaging(),
      quietWindow: async () => {},
      maxBytes: 1024,
    });
    expect(limited).toMatchObject({ status: "retry", reason: "too-large" });

    const failed = await captureStableStream({
      read: async () => ({ type: "file", chunks: failingStream() }),
      staging: new MemoryStaging(),
      quietWindow: async () => {},
    });
    expect(failed).toMatchObject({ status: "retry", reason: "io-error" });
  });
});

async function* stream(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

async function* failingStream(): AsyncIterable<Uint8Array> {
  yield new Uint8Array([1]);
  throw new Error("injected read failure");
}

async function* repeatedStream(chunk: Uint8Array, count: number): AsyncIterable<Uint8Array> {
  for (let index = 0; index < count; index += 1) yield chunk;
}

async function readBytes(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const values: number[] = [];
  for await (const chunk of chunks) values.push(...chunk);
  return new Uint8Array(values);
}
