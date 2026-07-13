import { createHash } from "node:crypto";

export type StreamReadObservation =
  | { type: "file"; chunks: AsyncIterable<Uint8Array> }
  | { type: "missing" | "other" };

export interface ImmutableStagingWriter {
  readonly ref: string;
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export interface ImmutableStagingArea {
  create(): Promise<ImmutableStagingWriter>;
  read(ref: string): Promise<AsyncIterable<Uint8Array>>;
  remove(ref: string): Promise<void>;
}

export interface StreamHash {
  hash: string;
  size: number;
}

export type StableStreamCaptureResult =
  | { status: "captured"; stagedRef: string; hash: string; size: number }
  | { status: "retry"; reason: "not-file" | "changed" | "stage-corrupt" | "too-large" | "io-error"; error?: unknown };

export async function sha256Stream(chunks: AsyncIterable<Uint8Array>, maxBytes = Number.MAX_SAFE_INTEGER): Promise<StreamHash> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of chunks) {
    size += chunk.byteLength;
    if (!Number.isSafeInteger(size) || size > maxBytes) throw new StreamSizeLimitError(maxBytes);
    hash.update(chunk);
  }
  return { hash: hash.digest("hex"), size };
}

export async function captureStableStream(input: {
  read: () => Promise<StreamReadObservation>;
  staging: ImmutableStagingArea;
  quietWindow: () => Promise<void>;
  maxBytes?: number;
}): Promise<StableStreamCaptureResult> {
  let writer: ImmutableStagingWriter | undefined;
  let closed = false;
  try {
    const first = await input.read();
    if (first.type !== "file") return { status: "retry", reason: "not-file" };
    writer = await input.staging.create();
    const firstHash = await copyAndHash(first.chunks, writer, input.maxBytes);
    await writer.close();
    closed = true;

    const stagedHash = await sha256Stream(await input.staging.read(writer.ref), input.maxBytes);
    if (!sameHash(firstHash, stagedHash)) {
      await input.staging.remove(writer.ref);
      return { status: "retry", reason: "stage-corrupt" };
    }

    await input.quietWindow();
    const second = await input.read();
    if (second.type !== "file") {
      await input.staging.remove(writer.ref);
      return { status: "retry", reason: "changed" };
    }
    const secondHash = await sha256Stream(second.chunks, input.maxBytes);
    if (!sameHash(firstHash, secondHash)) {
      await input.staging.remove(writer.ref);
      return { status: "retry", reason: "changed" };
    }
    return { status: "captured", stagedRef: writer.ref, ...firstHash };
  } catch (error) {
    if (writer) {
      if (closed) await input.staging.remove(writer.ref);
      else await writer.abort();
    }
    return error instanceof StreamSizeLimitError
      ? { status: "retry", reason: "too-large", error }
      : { status: "retry", reason: "io-error", error };
  }
}

class StreamSizeLimitError extends Error {
  constructor(readonly maxBytes: number) {
    super(`stream exceeds ${maxBytes} bytes`);
    this.name = "StreamSizeLimitError";
  }
}

async function copyAndHash(
  chunks: AsyncIterable<Uint8Array>,
  writer: ImmutableStagingWriter,
  maxBytes = Number.MAX_SAFE_INTEGER,
): Promise<StreamHash> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of chunks) {
    size += chunk.byteLength;
    if (!Number.isSafeInteger(size) || size > maxBytes) throw new StreamSizeLimitError(maxBytes);
    hash.update(chunk);
    await writer.write(chunk);
  }
  return { hash: hash.digest("hex"), size };
}

function sameHash(left: StreamHash, right: StreamHash): boolean {
  return left.size === right.size && left.hash === right.hash;
}
