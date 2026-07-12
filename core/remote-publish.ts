import type { ObjectStore } from "./object-store";
import { verifyImmutableObject, type ImmutableObject } from "./immutable-object";

export interface PublishEnvelope {
  blobs: ImmutableObject[];
  configTrees: ImmutableObject[];
  chunks: ImmutableObject[];
  commit: ImmutableObject;
}

export async function publishEnvelope(store: ObjectStore, envelope: PublishEnvelope): Promise<void> {
  for (const object of [...envelope.blobs, ...envelope.configTrees, ...envelope.chunks, envelope.commit]) await putVerifiedImmutable(store, object);
}

export async function putVerifiedImmutable(store: ObjectStore, object: ImmutableObject): Promise<void> {
  try {
    await store.putImmutable(object.key, object.bytes);
  } catch (error) {
    const existing = { ...object, bytes: await store.get(object.key) };
    verifyImmutableObject(existing, object);
    return;
  }
}
