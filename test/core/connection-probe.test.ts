import { describe, expect, it, vi } from "vitest";
import { probeReadableObjectStore, probeWritableObjectStore } from "../../core/connection-probe";
import { objectBodyFromBytes } from "../../core/object-store";
import { sha256Hex } from "../../protocol/hash";

describe("ObjectStore connection probe", () => {
  it("requires exactly one winner from competing immutable writes", async () => {
    let stored: Uint8Array | undefined;
    const store = {
      capabilities: { atomicCreate: "verified" as const },
      putImmutable: async (_key: string, bytes: Uint8Array) => {
        if (stored) throw new Error("exists");
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
    await expect(probeWritableObjectStore(common, "probe/key", new Uint8Array())).rejects.toThrow("write mode is disabled");
    expect(putImmutable).not.toHaveBeenCalled();
    const nonAtomic = { ...common, capabilities: { atomicCreate: "verified" as const } };
    await expect(probeWritableObjectStore(nonAtomic, "probe/key", new Uint8Array())).rejects.toThrow("exactly one winner");
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
      .rejects.toThrow("exactly one winner");
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
  });
});
