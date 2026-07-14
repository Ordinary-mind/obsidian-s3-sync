import { createHash, randomUUID } from "node:crypto";

export interface ContentStagingWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export interface ContentStagingAdapter {
  ensureDirectory(path: string): Promise<void>;
  createTemporary(ref: string): Promise<ContentStagingWriter>;
  read(ref: string): Promise<AsyncIterable<Uint8Array>>;
  installNoClobber(temporaryRef: string, contentRef: string): Promise<boolean>;
  remove(ref: string): Promise<void>;
  availableBytes?(): Promise<number | undefined>;
}

export interface StagedContent {
  ref: string;
  hash: string;
  size: number;
}

export class ContentStagingIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentStagingIntegrityError";
  }
}

export class ContentStagingSpaceError extends Error {
  constructor(readonly estimatedBytes: number, readonly availableBytes: number) {
    super(`content staging needs about ${estimatedBytes} bytes but only ${availableBytes} bytes are available`);
    this.name = "ContentStagingSpaceError";
  }
}

export class ImmutableContentStaging {
  constructor(private readonly adapter: ContentStagingAdapter) {}

  async stage(chunks: AsyncIterable<Uint8Array>, estimatedBytes?: number): Promise<StagedContent> {
    validateEstimate(estimatedBytes);
    await this.checkAvailableSpace(estimatedBytes);
    await this.adapter.ensureDirectory("staged");
    await this.adapter.ensureDirectory("staged/tmp");

    const temporaryRef = `staged/tmp/${randomUUID()}`;
    const writer = await this.adapter.createTemporary(temporaryRef);
    let writerOpen = true;
    let temporaryPresent = true;
    let installedRef: string | undefined;
    let completed = false;
    try {
      const expected = await writeAndHash(chunks, writer);
      await writer.close();
      writerOpen = false;
      await assertHashAndSize(this.adapter, temporaryRef, expected);

      const contentRef = contentStagingRef(expected.hash);
      await this.adapter.ensureDirectory("staged/sha256");
      await this.adapter.ensureDirectory(`staged/sha256/${expected.hash.slice(0, 2)}`);
      const installed = await this.adapter.installNoClobber(temporaryRef, contentRef);
      if (installed) {
        temporaryPresent = false;
        installedRef = contentRef;
        await assertHashAndSize(this.adapter, contentRef, expected);
      } else {
        const identical = await streamsEqual(
          await this.adapter.read(temporaryRef),
          await this.adapter.read(contentRef),
        );
        if (!identical) throw new ContentStagingIntegrityError(`content staging collision at ${contentRef}`);
        await assertHashAndSize(this.adapter, contentRef, expected);
      }
      completed = true;
      return { ref: contentRef, ...expected };
    } finally {
      if (writerOpen) {
        await writer.abort();
      } else if (temporaryPresent) {
        await this.adapter.remove(temporaryRef);
      }
      if (!completed && installedRef) await this.adapter.remove(installedRef);
    }
  }

  async verify(content: StagedContent): Promise<void>;
  async verify(contentRef: string, expected: { hash: string; size: number }): Promise<void>;
  async verify(content: StagedContent | string, expected?: { hash: string; size: number }): Promise<void> {
    const resolved = typeof content === "string"
      ? { ref: content, ...(expected ?? invalidExpectedContent()) }
      : content;
    if (resolved.ref !== contentStagingRef(resolved.hash)) {
      throw new ContentStagingIntegrityError("content staging reference does not match its hash");
    }
    await assertHashAndSize(this.adapter, resolved.ref, { hash: resolved.hash, size: resolved.size });
  }

  async read(contentRef: string): Promise<AsyncIterable<Uint8Array>> {
    if (!/^staged\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(contentRef)) {
      throw new ContentStagingIntegrityError("content staging reference is invalid");
    }
    return this.adapter.read(contentRef);
  }

  private async checkAvailableSpace(estimatedBytes: number | undefined): Promise<void> {
    if (estimatedBytes === undefined || !this.adapter.availableBytes) return;
    const available = await this.adapter.availableBytes();
    if (available !== undefined && available < estimatedBytes) {
      throw new ContentStagingSpaceError(estimatedBytes, available);
    }
  }
}

function invalidExpectedContent(): never {
  throw new ContentStagingIntegrityError("content staging verification needs an expected hash and size");
}

export function contentStagingRef(hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("content staging hash is invalid");
  return `staged/sha256/${hash.slice(0, 2)}/${hash}`;
}

async function writeAndHash(chunks: AsyncIterable<Uint8Array>, writer: ContentStagingWriter): Promise<{ hash: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of chunks) {
    size = addSize(size, chunk.byteLength);
    hash.update(chunk);
    await writer.write(chunk);
  }
  return { hash: hash.digest("hex"), size };
}

async function assertHashAndSize(
  adapter: ContentStagingAdapter,
  ref: string,
  expected: { hash: string; size: number },
): Promise<void> {
  const actual = await hashStream(await adapter.read(ref));
  if (actual.hash !== expected.hash || actual.size !== expected.size) {
    throw new ContentStagingIntegrityError(`content staging verification failed at ${ref}`);
  }
}

async function hashStream(chunks: AsyncIterable<Uint8Array>): Promise<{ hash: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of chunks) {
    size = addSize(size, chunk.byteLength);
    hash.update(chunk);
  }
  return { hash: hash.digest("hex"), size };
}

async function streamsEqual(left: AsyncIterable<Uint8Array>, right: AsyncIterable<Uint8Array>): Promise<boolean> {
  const leftBytes = flatten(left);
  const rightBytes = flatten(right);
  while (true) {
    const [leftNext, rightNext] = await Promise.all([leftBytes.next(), rightBytes.next()]);
    if (leftNext.done || rightNext.done) return leftNext.done === rightNext.done;
    if (leftNext.value !== rightNext.value) return false;
  }
}

async function* flatten(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<number> {
  for await (const chunk of chunks) {
    for (const byte of chunk) yield byte;
  }
}

function addSize(size: number, chunkSize: number): number {
  const next = size + chunkSize;
  if (!Number.isSafeInteger(next)) throw new Error("content staging size exceeds safe integer range");
  return next;
}

function validateEstimate(estimatedBytes: number | undefined): void {
  if (estimatedBytes !== undefined && (!Number.isSafeInteger(estimatedBytes) || estimatedBytes < 0)) {
    throw new Error("content staging estimate is invalid");
  }
}
