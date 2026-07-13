import { describe, expect, it } from "vitest";
import { DurableStateCorruptionError, DurableStateStore, type DurableStateFileAdapter, type StateJsonValue } from "../../core/durable-state";

class MemoryStateFiles implements DurableStateFileAdapter {
  readonly files = new Map<string, string>();
  corruptNextWrite = false;
  async read(name: "state-a.json" | "state-b.json"): Promise<string | undefined> { return this.files.get(name); }
  async write(name: "state-a.json" | "state-b.json", source: string): Promise<void> {
    this.files.set(name, this.corruptNextWrite ? source.slice(0, -1) : source);
    this.corruptNextWrite = false;
  }
}

describe("dual-copy durable state", () => {
  it("uses schema, generation, checksum, and falls back to the older valid copy", async () => {
    const files = new MemoryStateFiles();
    const store = new DurableStateStore<StateJsonValue>(files);
    await expect(store.load()).resolves.toBeUndefined();
    await expect(store.update(() => ({ value: 1 }))).resolves.toEqual({ generation: 1, payload: { value: 1 } });
    await expect(store.update(() => ({ value: 2 }))).resolves.toEqual({ generation: 2, payload: { value: 2 } });
    files.files.set("state-b.json", "corrupt");
    await expect(store.load()).resolves.toEqual({ generation: 1, payload: { value: 1 } });
    files.files.set("state-a.json", "corrupt");
    await expect(store.load()).rejects.toBeInstanceOf(DurableStateCorruptionError);
  });

  it("serializes concurrent transactions without losing an update", async () => {
    const files = new MemoryStateFiles();
    const store = new DurableStateStore<{ count: number }>(files);
    const first = store.update(async (current) => { await Promise.resolve(); return { count: (current?.count ?? 0) + 1 }; });
    const second = store.update((current) => ({ count: (current?.count ?? 0) + 1 }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { generation: 1, payload: { count: 1 } },
      { generation: 2, payload: { count: 2 } },
    ]);
    await expect(store.load()).resolves.toEqual({ generation: 2, payload: { count: 2 } });
  });

  it("rejects a torn write and preserves the prior copy", async () => {
    const files = new MemoryStateFiles();
    const store = new DurableStateStore<{ value: number }>(files);
    await store.update(() => ({ value: 1 }));
    files.corruptNextWrite = true;
    await expect(store.update(() => ({ value: 2 }))).rejects.toBeInstanceOf(DurableStateCorruptionError);
    await expect(store.load()).resolves.toEqual({ generation: 1, payload: { value: 1 } });
  });
});
