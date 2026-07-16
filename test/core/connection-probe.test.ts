import { describe, expect, it, vi } from "vitest";
import { probeReadableObjectStore, probeWritableObjectStore } from "../../core/connection-probe";
import { ObjectStoreError, objectBodyFromBytes } from "../../core/object-store";
import { sha256Hex } from "../../protocol/hash";

describe("ObjectStore connection probe", () => {
  it("requires exactly one winner from competing immutable writes", async () => {
    let stored: Uint8Array | undefined;
    const store = {
      capabilities: { atomicCreate: "verified" as const },
      putImmutable: async (_key: string, bytes: Uint8Array) => {
        if (stored) throw new ObjectStoreError("integrity", "put", { retries: 0, stage: "conditional-existing-different" });
        stored = new Uint8Array(bytes);
      },
      getStream: async () => objectBodyFromBytes(stored!),
      head: async () => ({ size: stored!.byteLength }),
      list: async () => ({ keys: ["probe/key"] }),
    };
    await expect(probeWritableObjectStore(store, "probe/key", new Uint8Array([1, 2, 3]))).resolves.toBeUndefined();
  });

  it("rejects unverified and non-atomic stores", async () => {
    const putImmutable = vi.fn(async () => undefined);
    const common = { getStream: async () => objectBodyFromBytes(new Uint8Array()), head: async () => ({ size: 0 }), list: async () => ({ keys: [] }), putImmutable };
    await expect(probeWritableObjectStore(common, "probe/key", new Uint8Array())).rejects.toMatchObject({
      kind: "integrity", operation: "put", details: { stage: "atomic-create-unverified" },
    });
    expect(putImmutable).not.toHaveBeenCalled();
    const nonAtomic = { ...common, capabilities: { atomicCreate: "verified" as const } };
    await expect(probeWritableObjectStore(nonAtomic, "probe/key", new Uint8Array())).rejects.toMatchObject({
      kind: "integrity", operation: "put", details: { stage: "atomic-create-multiple-winners" },
    });
  });

  it("detects a HEAD-then-PUT race across independent adapter instances", async () => {
    let stored: Uint8Array | undefined;
    let waiting = 0;
    let releaseChecks: (() => void) | undefined;
    const checksComplete = new Promise<void>((resolve) => { releaseChecks = resolve; });
    const brokenStore = () => ({
      capabilities: { atomicCreate: "verified" as const },
      putImmutable: async (_key: string, bytes: Uint8Array) => {
        if (stored) throw new Error("exists");
        waiting += 1;
        if (waiting === 2) releaseChecks!();
        await checksComplete;
        stored = new Uint8Array(bytes);
      },
      getStream: async () => objectBodyFromBytes(stored!),
      head: async () => ({ size: stored!.byteLength }),
      list: async () => ({ keys: ["probe/key"] }),
    });
    await expect(probeWritableObjectStore(brokenStore(), "probe/key", new Uint8Array([1]), brokenStore()))
      .rejects.toMatchObject({ kind: "integrity", operation: "put", details: { stage: "atomic-create-multiple-winners" } });
  });

  it("preserves the first request failure when neither conditional write succeeds", async () => {
    const failure = new ObjectStoreError("auth", "put", {
      status: 403,
      requestId: "request-403",
      retries: 0,
      stage: "conditional-create",
    });
    const store = {
      capabilities: { atomicCreate: "verified" as const },
      putImmutable: async () => { throw failure; },
      getStream: async () => objectBodyFromBytes(new Uint8Array()),
      head: async () => ({ size: 0 }),
      list: async () => ({ keys: [] }),
    };
    await expect(probeWritableObjectStore(store, "probe/key", new Uint8Array([1]))).rejects.toBe(failure);
  });

  it("rejects one apparent winner when the loser did not prove a conditional conflict", async () => {
    let attempts = 0;
    const store = {
      capabilities: { atomicCreate: "verified" as const },
      putImmutable: async () => {
        attempts += 1;
        if (attempts === 2) {
          throw new ObjectStoreError("temporary", "put", { status: 409, retries: 3, stage: "conditional-create" });
        }
      },
      getStream: async () => objectBodyFromBytes(new Uint8Array([1])),
      head: async () => ({ size: 1 }),
      list: async () => ({ keys: ["probe/key"] }),
    };
    await expect(probeWritableObjectStore(store, "probe/key", new Uint8Array([1]))).rejects.toMatchObject({
      kind: "temporary", operation: "put", details: { status: 409, retries: 3, stage: "conditional-create" },
    });
  });

  it("runs read-only diagnostics without issuing PUT", async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    const putImmutable = vi.fn(async () => undefined);
    const store = {
      putImmutable,
      getStream: async () => objectBodyFromBytes(bytes),
      head: async () => ({ size: bytes.byteLength }),
      list: async () => ({ keys: ["existing/key"] }),
    };
    await expect(probeReadableObjectStore(store, "existing/key", { hash: sha256Hex(bytes), size: bytes.byteLength })).resolves.toBeUndefined();
    expect(putImmutable).not.toHaveBeenCalled();
    await expect(probeReadableObjectStore(store, "existing/key", { hash: "0".repeat(64), size: bytes.byteLength }))
      .rejects.toMatchObject({ kind: "integrity", operation: "get", details: { stage: "probe-readback" } });
  });
});
