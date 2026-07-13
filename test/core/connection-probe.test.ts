import { describe, expect, it } from "vitest";
import { probeWritableObjectStore } from "../../core/connection-probe";

describe("writable ObjectStore probe", () => {
  it("requires immutable write, exact read-back, Head size and List visibility", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const store = { putImmutable: async () => undefined, get: async () => bytes, head: async () => ({ size: 3 }), list: async () => ({ keys: ["probe/key"] }) };
    await expect(probeWritableObjectStore(store, "probe/key", bytes)).resolves.toBeUndefined();
    await expect(probeWritableObjectStore({ ...store, list: async () => ({ keys: [] }) }, "probe/key", bytes)).rejects.toThrow("not visible");
  });
});
