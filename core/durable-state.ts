import { sha256Hex } from "../protocol/hash";
import { canonicalizeProtocolJson } from "../protocol/json";

export type StateJsonValue = null | boolean | number | string | StateJsonValue[] | { [key: string]: StateJsonValue };

export interface DurableStateSnapshot<T extends StateJsonValue> {
  generation: number;
  payload: T;
}

export interface DurableStateFileAdapter {
  read(name: "state-a.json" | "state-b.json"): Promise<string | undefined>;
  write(name: "state-a.json" | "state-b.json", source: string): Promise<void>;
}

interface DurableStateEnvelope<T extends StateJsonValue> {
  schemaVersion: 1;
  generation: number;
  payloadHash: string;
  payload: T;
}

export class DurableStateCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurableStateCorruptionError";
  }
}

export class DurableStateStore<T extends StateJsonValue> {
  private writeQueue = Promise.resolve();

  constructor(private readonly adapter: DurableStateFileAdapter) {}

  async load(): Promise<DurableStateSnapshot<T> | undefined> {
    await this.writeQueue;
    return this.loadUnlocked();
  }

  update(mutator: (current: T | undefined) => T | Promise<T>): Promise<DurableStateSnapshot<T>> {
    let result!: DurableStateSnapshot<T>;
    const operation = this.writeQueue.then(async () => {
      const current = await this.loadUnlocked();
      const payload = cloneJson(await mutator(current ? cloneJson(current.payload) : undefined));
      const generation = (current?.generation ?? 0) + 1;
      if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error("durable state generation exhausted");
      const source = encodeEnvelope(generation, payload);
      const name = generation % 2 === 1 ? "state-a.json" : "state-b.json";
      await this.adapter.write(name, source);
      const readback = await this.adapter.read(name);
      if (readback === undefined) throw new DurableStateCorruptionError("durable state write was not readable");
      const verified = parseEnvelope<T>(readback);
      if (verified.generation !== generation || canonicalizeProtocolJson(verified.payload) !== canonicalizeProtocolJson(payload)) {
        throw new DurableStateCorruptionError("durable state write readback mismatch");
      }
      result = { generation, payload: cloneJson(payload) };
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation.then(() => result);
  }

  private async loadUnlocked(): Promise<DurableStateSnapshot<T> | undefined> {
    const sources = await Promise.all([this.adapter.read("state-a.json"), this.adapter.read("state-b.json")]);
    const valid: DurableStateEnvelope<T>[] = [];
    let present = 0;
    for (const source of sources) {
      if (source === undefined) continue;
      present += 1;
      try { valid.push(parseEnvelope<T>(source)); } catch { /* 损坏副本只在没有可恢复副本时阻断。 */ }
    }
    if (valid.length === 0) {
      if (present > 0) throw new DurableStateCorruptionError("all durable state copies are invalid");
      return undefined;
    }
    valid.sort((left, right) => right.generation - left.generation);
    if (valid.length > 1 && valid[0].generation === valid[1].generation && valid[0].payloadHash !== valid[1].payloadHash) {
      throw new DurableStateCorruptionError("durable state copies disagree at the same generation");
    }
    return { generation: valid[0].generation, payload: cloneJson(valid[0].payload) };
  }
}

function encodeEnvelope<T extends StateJsonValue>(generation: number, payload: T): string {
  const payloadHash = sha256Hex(new TextEncoder().encode(canonicalizeProtocolJson(payload)));
  return canonicalizeProtocolJson({ schemaVersion: 1, generation, payloadHash, payload } satisfies DurableStateEnvelope<T>);
}

function parseEnvelope<T extends StateJsonValue>(source: string): DurableStateEnvelope<T> {
  try {
    const value = JSON.parse(source) as Partial<DurableStateEnvelope<T>>;
    if (canonicalizeProtocolJson(value) !== source) throw new DurableStateCorruptionError("durable state is not canonical JSON");
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.generation) || value.generation! <= 0
      || typeof value.payloadHash !== "string" || !/^[0-9a-f]{64}$/.test(value.payloadHash) || value.payload === undefined) {
      throw new DurableStateCorruptionError("durable state envelope is invalid");
    }
    const actualHash = sha256Hex(new TextEncoder().encode(canonicalizeProtocolJson(value.payload)));
    if (actualHash !== value.payloadHash) throw new DurableStateCorruptionError("durable state checksum mismatch");
    return value as DurableStateEnvelope<T>;
  } catch (error) {
    if (error instanceof DurableStateCorruptionError) throw error;
    throw new DurableStateCorruptionError("durable state JSON is invalid");
  }
}

function cloneJson<T extends StateJsonValue>(value: T): T {
  return JSON.parse(canonicalizeProtocolJson(value)) as T;
}
