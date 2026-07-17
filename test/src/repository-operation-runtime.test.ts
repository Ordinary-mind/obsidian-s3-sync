import { describe, expect, it } from "vitest";
import { RepositoryOperationRuntime } from "../../src/repository-operation-runtime";

describe("repository operation runtime", () => {
  it("owns one cancellable operation and releases it deterministically", () => {
    const runtime = new RepositoryOperationRuntime();
    expect(runtime.tryAcquire("vault")).toBe(true);
    const signal = runtime.currentSignal();
    expect(signal?.aborted).toBe(false);
    expect(runtime.tryAcquire("config")).toBe(false);

    runtime.release("vault");

    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toMatchObject({ name: "AbortError", code: "REPOSITORY_OPERATION_CANCELLED" });
    expect(runtime.isRunning()).toBe(false);
    expect(runtime.tryAcquire("config")).toBe(true);
  });

  it("cancels the active operation and rejects new work after disposal", () => {
    const runtime = new RepositoryOperationRuntime();
    runtime.acquire("vault");
    const signal = runtime.currentSignal();

    runtime.dispose();

    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toMatchObject({ name: "AbortError", code: "REPOSITORY_OPERATION_CANCELLED" });
    expect(() => runtime.throwIfAborted("vault")).toThrow();
    runtime.release("vault");
    expect(runtime.tryAcquire("config")).toBe(false);
    expect(() => runtime.acquire("config")).toThrow("disposed");
  });

  it("reports lock contention and owner mismatches with stable diagnostics", () => {
    const runtime = new RepositoryOperationRuntime();
    runtime.acquire("vault");
    expect(() => runtime.acquire("config")).toThrow(expect.objectContaining({ code: "REPOSITORY_OPERATION_BUSY" }));
    expect(() => runtime.release("config")).toThrow(expect.objectContaining({ code: "REPOSITORY_OPERATION_OWNERSHIP_INVALID" }));
    runtime.release("vault");
  });
});
