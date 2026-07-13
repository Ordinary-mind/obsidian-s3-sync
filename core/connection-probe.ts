import { sha256Hex } from "../protocol/hash";
import { readObjectBytes, type ObjectStore, type ObjectStoreCapabilitySource } from "./object-store";

export interface ReadableObjectProbeExpectation {
  hash: string;
  size: number;
}

export async function probeReadableObjectStore(
  store: ObjectStore,
  key: string,
  expectation: ReadableObjectProbeExpectation,
): Promise<void> {
  const readBack = await readObjectBytes(store, key, { maximumBytes: expectation.size });
  if (readBack.byteLength !== expectation.size || sha256Hex(readBack) !== expectation.hash) {
    throw new Error("connection probe read-back bytes differ");
  }
  const metadata = await store.head(key);
  if (metadata.size !== expectation.size) throw new Error("connection probe object size differs");
  const page = await store.list(key);
  if (!page.keys.includes(key)) throw new Error("connection probe object is not visible to List");
}

export async function probeWritableObjectStore(
  store: ObjectStore,
  key: string,
  bytes: Uint8Array,
  competitorStore: ObjectStore = store,
): Promise<void> {
  if (!hasVerifiedAtomicCreate(store) || !hasVerifiedAtomicCreate(competitorStore)) {
    throw new Error("ObjectStore atomic create is not verified; write mode is disabled");
  }
  const competitor = new Uint8Array(bytes.byteLength + 1);
  competitor.set(bytes);
  competitor[competitor.byteLength - 1] = 0xff;
  const writes = await Promise.allSettled([
    store.putImmutable(key, bytes),
    competitorStore.putImmutable(key, competitor),
  ]);
  const winners = writes.flatMap((result, index) => result.status === "fulfilled" ? [index === 0 ? bytes : competitor] : []);
  if (winners.length !== 1) throw new Error("ObjectStore atomic create probe did not produce exactly one winner");
  await probeReadableObjectStore(store, key, { hash: sha256Hex(winners[0]), size: winners[0].byteLength });
}

function hasVerifiedAtomicCreate(store: ObjectStore): store is ObjectStore & ObjectStoreCapabilitySource {
  return (store as Partial<ObjectStoreCapabilitySource>).capabilities?.atomicCreate === "verified";
}
