import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { S3ObjectStore } from "../../adapters/s3-object-store";
import { ObjectStoreError, readObjectBytes } from "../../core/object-store";

const base = { endpoint: "https://s3.example", region: "us-east-1", bucket: "vault", forcePathStyle: false };

describe("v1 S3 ObjectStore adapter contract", () => {
  it("uses conditional immutable PUT and does not expose DeleteObject", () => {
    const source = readFileSync(new URL("../../adapters/s3-object-store.ts", import.meta.url), "utf8");
    expect(source).toContain('IfNoneMatch: "*"');
    expect(source).not.toContain("DeleteObjectCommand");
  });

  it("passes pagination and delimiter while normalizing duplicate unordered pages", async () => {
    const send = vi.fn(async (command: any) => {
      expect(command.input).toMatchObject({ Prefix: "root/", ContinuationToken: "next", Delimiter: "/" });
      return { Contents: [{ Key: "root/b" }, { Key: "root/a" }, { Key: "root/a" }], CommonPrefixes: [{ Prefix: "root/z/" }], NextContinuationToken: "last" };
    });
    const store = new S3ObjectStore({ ...base, client: { send } });
    await expect(store.list("root/", "next", { delimiter: "/" })).resolves.toEqual({
      keys: ["root/a", "root/b"],
      commonPrefixes: ["root/z/"],
      continuationToken: "last",
    });
  });

  it("streams Get bodies without buffering in the adapter", async () => {
    const body = streamBody(new Uint8Array([1, 2]), new Uint8Array([3]));
    const store = new S3ObjectStore({ ...base, client: { send: async () => ({ Body: body }) } });
    await expect(readObjectBytes(store, "root/value")).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  it("rejects different existing bytes without overwriting and keeps retries version-idempotent", async () => {
    let stored: Uint8Array | undefined;
    let versions = 0;
    const client = { send: async (command: any) => {
      if (command.constructor.name === "PutObjectCommand") {
        if (stored) throw Object.assign(new Error("exists"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
        stored = new Uint8Array(command.input.Body);
        versions += 1;
        return {};
      }
      if (command.constructor.name === "GetObjectCommand") return { Body: streamBody(stored!) };
      throw new Error("unexpected command");
    } };
    const store = new S3ObjectStore({ ...base, client });
    const original = new Uint8Array([1, 2, 3]);
    await store.putImmutable("immutable/key", original);
    await Promise.all(Array.from({ length: 5 }, () => store.putImmutable("immutable/key", original)));
    expect(versions).toBe(1);
    await expect(store.putImmutable("immutable/key", new Uint8Array([9, 9, 9])))
      .rejects.toMatchObject({ kind: "integrity", operation: "put" });
    expect(stored).toEqual(original);
  });

  it("retries throttling with bounded exponential delays and exposes only sanitized diagnostics", async () => {
    const diagnostics: ObjectStoreError[] = [];
    const sleep = vi.fn(async () => undefined);
    let attempts = 0;
    const store = new S3ObjectStore({
      ...base,
      retryBaseMs: 10,
      retryMaximumMs: 15,
      sleep,
      onDiagnostic: (error) => diagnostics.push(error),
      client: { send: async () => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error("secret endpoint/key"), { name: "SlowDown", $metadata: { httpStatusCode: 429, requestId: `request-${attempts}` } });
        return { ContentLength: 7 };
      } },
    });
    await expect(store.head("private/key")).resolves.toEqual({ size: 7 });
    expect(sleep).toHaveBeenNthCalledWith(1, 10, undefined);
    expect(sleep).toHaveBeenNthCalledWith(2, 15, undefined);
    expect(diagnostics.map((error) => error.details)).toEqual([
      { status: 429, requestId: "request-1", retries: 0, stage: "request" },
      { status: 429, requestId: "request-2", retries: 1, stage: "request" },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("private/key");
    expect(JSON.stringify(diagnostics)).not.toContain("secret endpoint/key");
  });

  it("classifies timeout and caller cancellation separately", async () => {
    const waitingClient = { send: (_command: unknown, options?: { abortSignal?: AbortSignal }) => new Promise((_resolve, reject) => {
      options?.abortSignal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    }) };
    const timed = new S3ObjectStore({ ...base, client: waitingClient, requestTimeoutMs: 5, maximumAttempts: 1 });
    await expect(timed.head("key")).rejects.toMatchObject({ kind: "temporary", operation: "head" });

    const controller = new AbortController();
    const cancelled = new S3ObjectStore({ ...base, client: waitingClient, requestTimeoutMs: 100, maximumAttempts: 1 });
    const request = cancelled.head("key", { signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toMatchObject({ kind: "cancelled", operation: "head" });
  });

  it("limits concurrent requests", async () => {
    let active = 0;
    let maximum = 0;
    const resolvers: Array<() => void> = [];
    const store = new S3ObjectStore({ ...base, maximumConcurrency: 2, client: { send: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => resolvers.push(resolve));
      active -= 1;
      return { ContentLength: 1 };
    } } });
    const requests = [store.head("a"), store.head("b"), store.head("c")];
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers.shift()!();
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers.splice(0).forEach((resolve) => resolve());
    await Promise.all(requests);
    expect(maximum).toBe(2);
  });
});

function streamBody(...chunks: Uint8Array[]): { transformToWebStream(): ReadableStream<Uint8Array> } {
  return {
    transformToWebStream: () => new ReadableStream({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(chunk));
        controller.close();
      },
    }),
  };
}
