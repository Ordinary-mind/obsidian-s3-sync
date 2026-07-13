import { assertObjectBodyHash } from "../protocol/hash";
import { blobKey } from "../protocol/keys";
import type { ObjectStore } from "./object-store";

export async function downloadVerifiedBlob(
  store: ObjectStore,
  prefix: string,
  repositoryId: string,
  blob: { hash: string; size: number },
): Promise<Uint8Array> {
  const bytes = await store.get(blobKey(prefix, repositoryId, blob.hash));
  if (bytes.byteLength !== blob.size) throw new Error("remote Blob size differs from its Mutation");
  assertObjectBodyHash(blob.hash, bytes);
  return bytes;
}
