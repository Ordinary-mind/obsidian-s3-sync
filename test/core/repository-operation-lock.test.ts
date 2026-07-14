import { describe, expect, it } from "vitest";
import { RepositoryOperationLock } from "../../core/repository-operation-lock";

describe("shared repository operation lock", () => {
  it("serializes Config and Vault owners without allowing cross-owner release", () => {
    const lock = new RepositoryOperationLock();
    expect(lock.tryAcquire("config")).toBe(true);
    expect(lock.isHeldBy("config")).toBe(true);
    expect(lock.tryAcquire("vault")).toBe(false);
    expect(() => lock.release("vault")).toThrow("not held by vault");
    lock.release("config");
    expect(lock.tryAcquire("vault")).toBe(true);
    expect(() => lock.acquire("config")).toThrow("already held by vault");
    lock.release("vault");
    expect(lock.isRunning()).toBe(false);
  });
});
