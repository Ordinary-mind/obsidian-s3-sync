import { sha256Hex } from "../protocol/hash";
import { ObjectStoreError, readObjectBytes, type ObjectStore, type ObjectStoreCapabilitySource } from "./object-store";

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
    throw probeFailure("integrity", "get", "probe-readback");
  }
  const metadata = await store.head(key);
  if (metadata.size !== expectation.size) throw probeFailure("integrity", "head", "probe-size");
  const page = await store.list(key);
  if (!page.keys.includes(key)) throw probeFailure("temporary", "list", "probe-not-visible");
}

export async function probeWritableObjectStore(
  store: ObjectStore,
  key: string,
  bytes: Uint8Array,
  competitorStore: ObjectStore = store,
): Promise<void> {
  if (!hasVerifiedAtomicCreate(store) || !hasVerifiedAtomicCreate(competitorStore)) {
    throw probeFailure("integrity", "put", "atomic-create-unverified");
  }
  const competitor = new Uint8Array(bytes.byteLength + 1);
  competitor.set(bytes);
  competitor[competitor.byteLength - 1] = 0xff;
  const writes = await Promise.allSettled([
    store.putImmutable(key, bytes),
    competitorStore.putImmutable(key, competitor),
  ]);
  const winners = writes.flatMap((result, index) => result.status === "fulfilled" ? [{ index, bytes: index === 0 ? bytes : competitor }] : []);
  const losers = writes.flatMap((result, index) => result.status === "rejected" ? [{ index, reason: result.reason }] : []);
  if (winners.length === 0) throwPreservingStoreFailure(losers[0]?.reason, "atomic-create-no-winner");
  if (winners.length > 1) throw probeFailure("integrity", "put", "atomic-create-multiple-winners");
  if (losers.length !== 1) throw probeFailure("integrity", "put", "atomic-create-loser-missing");
  if (!(losers[0].reason instanceof ObjectStoreError)
    || losers[0].reason.kind !== "integrity"
    || losers[0].reason.operation !== "put"
    || losers[0].reason.details.stage !== "conditional-existing-different") {
    throwPreservingStoreFailure(losers[0].reason, "atomic-create-loser-unclassified");
  }
  await probeReadableObjectStore(store, key, { hash: sha256Hex(winners[0].bytes), size: winners[0].bytes.byteLength });
}

function hasVerifiedAtomicCreate(store: ObjectStore): store is ObjectStore & ObjectStoreCapabilitySource {
  return (store as Partial<ObjectStoreCapabilitySource>).capabilities?.atomicCreate === "verified";
}

function throwPreservingStoreFailure(reason: unknown, fallbackStage: string): never {
  if (reason instanceof ObjectStoreError) throw reason;
  throw probeFailure("temporary", "put", fallbackStage);
}

function probeFailure(
  kind: ConstructorParameters<typeof ObjectStoreError>[0],
  operation: ConstructorParameters<typeof ObjectStoreError>[1],
  stage: string,
): ObjectStoreError {
  return new ObjectStoreError(kind, operation, { retries: 0, stage });
}
