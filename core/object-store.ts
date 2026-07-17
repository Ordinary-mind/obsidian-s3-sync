import { createHash } from "node:crypto";
import { DiagnosticError } from "./diagnostics";

export type ObjectStoreOperation = "list" | "get" | "head" | "put" | "delete-probe";
export type ObjectStoreFailureKind = "not-found" | "temporary" | "throttled" | "auth" | "integrity" | "cancelled";

export interface ObjectStoreRequestOptions {
  signal?: AbortSignal;
}

export interface ObjectStoreListOptions extends ObjectStoreRequestOptions {
  delimiter?: string;
}

export interface ObjectStoreListedObject {
  key: string;
  size: number;
}

export interface ObjectStoreListPage {
  keys: string[];
  objects?: ObjectStoreListedObject[];
  commonPrefixes?: string[];
  continuationToken?: string;
}

export interface ObjectStore {
  list(prefix: string, continuationToken?: string, options?: ObjectStoreListOptions): Promise<ObjectStoreListPage>;
  getStream(key: string, options?: ObjectStoreRequestOptions): Promise<AsyncIterable<Uint8Array>>;
  head(key: string, options?: ObjectStoreRequestOptions): Promise<{ size: number }>;
  putImmutable(key: string, bytes: Uint8Array, options?: ObjectStoreRequestOptions): Promise<void>;
  putImmutableStream?(
    key: string,
    openBody: ReplayableObjectBody,
    expected: ImmutableStreamIdentity,
    options?: ObjectStoreRequestOptions,
  ): Promise<void>;
}

export type ReplayableObjectBody = () => Promise<AsyncIterable<Uint8Array>>;

export interface ImmutableStreamIdentity {
  hash: string;
  size: number;
}

export interface ObjectStoreCapabilities {
  atomicCreate: "verified" | "unverified";
}

export interface ObjectStoreCapabilitySource {
  readonly capabilities: ObjectStoreCapabilities;
}

export interface ObjectStoreDeleteProbe {
  deleteProbe(key: string, options?: ObjectStoreRequestOptions): Promise<void>;
}

export class ObjectStoreError extends Error {
  constructor(
    readonly kind: ObjectStoreFailureKind,
    readonly operation: ObjectStoreOperation,
    readonly details: { status?: number; requestId?: string; retries: number; stage: string },
    readonly cause?: unknown,
  ) {
    super(`ObjectStore ${operation} failed during ${details.stage}`);
    this.name = "ObjectStoreError";
  }
}

export function repeatedContinuationTokenError(): DiagnosticError {
  return new DiagnosticError(
    "OBJECT_STORE_PAGINATION_TOKEN_REPEATED",
    "integrity",
    "ObjectStore returned a repeated continuation token",
    new ObjectStoreError("integrity", "list", { retries: 0, stage: "pagination-token" }),
  );
}

export async function readObjectBytes(
  store: Pick<ObjectStore, "getStream">,
  key: string,
  options: ObjectStoreRequestOptions & { maximumBytes?: number; expectedHash?: string } = {},
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const hash = options.expectedHash === undefined ? undefined : createHash("sha256");
  let size = 0;
  for await (const chunk of await store.getStream(key, options)) {
    if (options.signal?.aborted) throw cancelledGetError();
    if (!(chunk instanceof Uint8Array)) throw new ObjectStoreError("integrity", "get", { retries: 0, stage: "stream" });
    size += chunk.byteLength;
    if (!Number.isSafeInteger(size) || (options.maximumBytes !== undefined && size > options.maximumBytes)) {
      throw new ObjectStoreError("integrity", "get", { retries: 0, stage: "size-limit" });
    }
    hash?.update(chunk);
    chunks.push(chunk);
  }
  if (options.signal?.aborted) throw cancelledGetError();
  if (hash && hash.digest("hex") !== options.expectedHash) {
    throw new ObjectStoreError("integrity", "get", { retries: 0, stage: "hash" });
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function hashObjectStream(
  chunks: AsyncIterable<Uint8Array>,
  options: ObjectStoreRequestOptions & { maximumBytes?: number } = {},
): Promise<{ hash: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of chunks) {
    if (options.signal?.aborted) throw cancelledGetError();
    if (!(chunk instanceof Uint8Array)) throw new ObjectStoreError("integrity", "get", { retries: 0, stage: "stream" });
    size += chunk.byteLength;
    if (!Number.isSafeInteger(size) || (options.maximumBytes !== undefined && size > options.maximumBytes)) {
      throw new ObjectStoreError("integrity", "get", { retries: 0, stage: "size-limit" });
    }
    hash.update(chunk);
  }
  if (options.signal?.aborted) throw cancelledGetError();
  return { hash: hash.digest("hex"), size };
}

export async function verifyObjectStream(
  store: Pick<ObjectStore, "getStream">,
  key: string,
  expected: ImmutableStreamIdentity,
  options: ObjectStoreRequestOptions = {},
): Promise<void> {
  assertImmutableStreamIdentity(expected);
  const actual = await hashObjectStream(await store.getStream(key, options), {
    ...options,
    maximumBytes: expected.size,
  });
  if (actual.size !== expected.size) {
    throw new ObjectStoreError("integrity", "get", { retries: 0, stage: "size" });
  }
  if (actual.hash !== expected.hash) {
    throw new ObjectStoreError("integrity", "get", { retries: 0, stage: "hash" });
  }
}

export function assertImmutableStreamIdentity(expected: ImmutableStreamIdentity): void {
  if (!/^[0-9a-f]{64}$/.test(expected.hash)) throw new Error("immutable stream Hash is invalid");
  if (!Number.isSafeInteger(expected.size) || expected.size < 0) throw new Error("immutable stream size is invalid");
}

export async function* objectBodyFromBytes(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield new Uint8Array(bytes);
}

export function canWriteAfterProbe(atomicCreateVerified: boolean): boolean {
  return atomicCreateVerified;
}

function cancelledGetError(): ObjectStoreError {
  return new ObjectStoreError("cancelled", "get", { retries: 0, stage: "stream" });
}
