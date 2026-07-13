import { blobKey } from "../protocol/keys";
import { readObjectBytes, type ObjectStore } from "./object-store";

export async function downloadVerifiedBlob(
  store: ObjectStore,
  prefix: string,
  repositoryId: string,
  blob: { hash: string; size: number },
): Promise<Uint8Array> {
  const bytes = await readObjectBytes(store, blobKey(prefix, repositoryId, blob.hash), { maximumBytes: blob.size, expectedHash: blob.hash });
  if (bytes.byteLength !== blob.size) throw new Error("remote Blob size differs from its Mutation");
  return bytes;
}
