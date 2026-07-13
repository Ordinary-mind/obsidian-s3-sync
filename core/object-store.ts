export type ObjectStoreOperation = "list" | "get" | "head" | "put" | "delete-probe";
export type ObjectStoreFailureKind = "not-found" | "temporary" | "throttled" | "auth" | "integrity" | "cancelled";

export interface ObjectStoreRequestOptions {
  signal?: AbortSignal;
}

export interface ObjectStoreListOptions extends ObjectStoreRequestOptions {
  delimiter?: string;
}

export interface ObjectStoreListPage {
  keys: string[];
  commonPrefixes?: string[];
  continuationToken?: string;
}

export interface ObjectStore {
  list(prefix: string, continuationToken?: string, options?: ObjectStoreListOptions): Promise<ObjectStoreListPage>;
  getStream(key: string, options?: ObjectStoreRequestOptions): Promise<AsyncIterable<Uint8Array>>;
  head(key: string, options?: ObjectStoreRequestOptions): Promise<{ size: number }>;
  putImmutable(key: string, bytes: Uint8Array, options?: ObjectStoreRequestOptions): Promise<void>;
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
    options?: { cause?: unknown },
  ) {
    super(`ObjectStore ${operation} failed during ${details.stage}`, options);
    this.name = "ObjectStoreError";
  }
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
    if (!(chunk instanceof Uint8Array)) throw new ObjectStoreError("integrity", "get", { retries: 0, stage: "stream" });
    size += chunk.byteLength;
    if (options.maximumBytes !== undefined && size > options.maximumBytes) {
      throw new ObjectStoreError("integrity", "get", { retries: 0, stage: "size-limit" });
    }
    hash?.update(chunk);
    chunks.push(chunk);
  }
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

export async function* objectBodyFromBytes(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield new Uint8Array(bytes);
}

export function canWriteAfterProbe(atomicCreateVerified: boolean): boolean {
  return atomicCreateVerified;
}
import { createHash } from "node:crypto";
