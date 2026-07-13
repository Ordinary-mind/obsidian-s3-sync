import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { retryDelayMs } from "../core/backoff";
import {
  ObjectStoreError,
  readObjectBytes,
  type ObjectStore,
  type ObjectStoreFailureKind,
  type ObjectStoreListOptions,
  type ObjectStoreOperation,
  type ObjectStoreRequestOptions,
} from "../core/object-store";
import type { RepositoryEndpoint } from "../core/locator";

interface S3Sender {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<any>;
}

export interface S3ObjectStoreOptions extends RepositoryEndpoint {
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  requestTimeoutMs?: number;
  maximumAttempts?: number;
  maximumConcurrency?: number;
  retryBaseMs?: number;
  retryMaximumMs?: number;
  onDiagnostic?: (error: ObjectStoreError) => void;
  client?: S3Sender;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export class S3ObjectStore implements ObjectStore {
  readonly capabilities = Object.freeze({ atomicCreate: "verified" as const });
  private readonly client: S3Sender;
  private readonly limiter: ConcurrencyLimiter;

  constructor(private readonly options: S3ObjectStoreOptions) {
    this.client = options.client ?? new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: options.credentials,
      maxAttempts: 1,
    });
    this.limiter = new ConcurrencyLimiter(options.maximumConcurrency ?? 4);
  }

  async list(prefix: string, continuationToken?: string, options?: ObjectStoreListOptions): Promise<{ keys: string[]; commonPrefixes?: string[]; continuationToken?: string }> {
    const result = await this.execute("list", "request", options?.signal, (signal) => this.client.send(new ListObjectsV2Command({
      Bucket: this.options.bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      Delimiter: options?.delimiter,
    }), { abortSignal: signal }));
    return {
      keys: [...new Set<string>((result.Contents ?? []).flatMap((entry: { Key?: string }): string[] => entry.Key ? [entry.Key] : []))].sort(),
      commonPrefixes: [...new Set<string>((result.CommonPrefixes ?? []).flatMap((entry: { Prefix?: string }): string[] => entry.Prefix ? [entry.Prefix] : []))].sort(),
      continuationToken: result.NextContinuationToken,
    };
  }

  async getStream(key: string, options?: ObjectStoreRequestOptions): Promise<AsyncIterable<Uint8Array>> {
    const result = await this.execute("get", "request", options?.signal, (signal) => this.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      { abortSignal: signal },
    ));
    if (!result.Body) throw this.failure("integrity", "get", 0, "response-body");
    return toAsyncBytes(result.Body.transformToWebStream());
  }

  async head(key: string, options?: ObjectStoreRequestOptions): Promise<{ size: number }> {
    const result = await this.execute("head", "request", options?.signal, (signal) => this.client.send(
      new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }),
      { abortSignal: signal },
    ));
    if (result.ContentLength === undefined) throw this.failure("integrity", "head", 0, "response-metadata");
    return { size: result.ContentLength };
  }

  async putImmutable(key: string, bytes: Uint8Array, options?: ObjectStoreRequestOptions): Promise<void> {
    try {
      await this.execute("put", "conditional-create", options?.signal, (signal) => this.client.send(
        new PutObjectCommand({ Bucket: this.options.bucket, Key: key, Body: bytes, IfNoneMatch: "*" }),
        { abortSignal: signal },
      ));
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error;
    }

    let stored: Uint8Array;
    try {
      stored = await readObjectBytes(this, key, { signal: options?.signal, maximumBytes: bytes.byteLength });
    } catch (error) {
      if (error instanceof ObjectStoreError && error.kind === "integrity") {
        throw this.failure("integrity", "put", 0, "verify");
      }
      throw error;
    }
    if (!equalBytes(stored, bytes)) throw this.failure("integrity", "put", 0, "verify");
  }

  private async execute<T>(
    operation: ObjectStoreOperation,
    stage: string,
    signal: AbortSignal | undefined,
    request: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const maximumAttempts = this.options.maximumAttempts ?? 4;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      let release: (() => void) | undefined;
      try {
        release = await this.limiter.acquire(signal);
        return await withTimeout(request, this.options.requestTimeoutMs ?? 30_000, signal);
      } catch (cause) {
        const error = classifyS3Failure(cause, operation, attempt, stage, signal?.aborted === true);
        const retryable = error.kind === "temporary" || error.kind === "throttled";
        if (!retryable || attempt + 1 >= maximumAttempts) {
          this.options.onDiagnostic?.(error);
          throw error;
        }
        this.options.onDiagnostic?.(error);
        release?.();
        release = undefined;
        const delay = retryDelayMs(attempt, this.options.retryBaseMs ?? 250, this.options.retryMaximumMs ?? 5_000);
        try {
          await (this.options.sleep ?? sleep)(delay, signal);
        } catch (sleepError) {
          throw classifyS3Failure(sleepError, operation, attempt, "backoff", signal?.aborted === true);
        }
      } finally {
        release?.();
      }
    }
    throw this.failure("temporary", operation, maximumAttempts - 1, stage);
  }

  private failure(kind: ObjectStoreFailureKind, operation: ObjectStoreOperation, retries: number, stage: string): ObjectStoreError {
    const error = new ObjectStoreError(kind, operation, { retries, stage });
    this.options.onDiagnostic?.(error);
    return error;
  }
}

class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("invalid ObjectStore concurrency limit");
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortError();
    if (this.active >= this.maximum) {
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          signal?.removeEventListener("abort", cancelled);
          resolve();
        };
        const cancelled = () => {
          const index = this.waiters.indexOf(ready);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortError());
        };
        this.waiters.push(ready);
        signal?.addEventListener("abort", cancelled, { once: true });
      });
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }
}

async function withTimeout<T>(request: (signal: AbortSignal) => Promise<T>, timeoutMs: number, callerSignal?: AbortSignal): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("invalid ObjectStore request timeout");
  if (callerSignal?.aborted) throw abortError();
  const controller = new AbortController();
  const cancel = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("ObjectStore request timed out")), timeoutMs);
  try {
    return await request(controller.signal);
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", cancel);
  }
}

async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

async function* toAsyncBytes(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}

function classifyS3Failure(cause: unknown, operation: ObjectStoreOperation, retries: number, stage: string, callerCancelled: boolean): ObjectStoreError {
  if (cause instanceof ObjectStoreError) return cause;
  const value = cause && typeof cause === "object" ? cause as {
    name?: unknown;
    Code?: unknown;
    $metadata?: { httpStatusCode?: unknown; requestId?: unknown };
  } : undefined;
  const status = typeof value?.$metadata?.httpStatusCode === "number" ? value.$metadata.httpStatusCode : undefined;
  const requestId = typeof value?.$metadata?.requestId === "string" ? value.$metadata.requestId : undefined;
  const name = typeof value?.name === "string" ? value.name : "";
  const code = typeof value?.Code === "string" ? value.Code : "";
  let kind: ObjectStoreFailureKind;
  if (callerCancelled) kind = "cancelled";
  else if (status === 404 || name === "NoSuchKey" || code === "NoSuchKey") kind = "not-found";
  else if (status === 401 || status === 403 || name === "AccessDenied" || code === "AccessDenied") kind = "auth";
  else if (status === 429 || name === "SlowDown" || code === "SlowDown" || name === "ThrottlingException") kind = "throttled";
  else if (status === 412 || name === "PreconditionFailed") kind = "integrity";
  else kind = "temporary";
  return new ObjectStoreError(kind, operation, { status, requestId, retries, stage }, { cause });
}

function isPreconditionFailure(error: unknown): boolean {
  return error instanceof ObjectStoreError && error.details.status === 412;
}

function abortError(): Error {
  const error = new Error("operation cancelled");
  error.name = "AbortError";
  return error;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}
