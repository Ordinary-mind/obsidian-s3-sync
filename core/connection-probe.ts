import type { ObjectStore } from "./object-store";

export async function probeWritableObjectStore(store: ObjectStore, key: string, bytes: Uint8Array): Promise<void> {
  await store.putImmutable(key, bytes);
  const readBack = await store.get(key);
  if (!sameBytes(readBack, bytes)) throw new Error("connection probe read-back bytes differ");
  const metadata = await store.head(key);
  if (metadata.size !== bytes.byteLength) throw new Error("connection probe object size differs");
  const page = await store.list(key);
  if (!page.keys.includes(key)) throw new Error("connection probe object is not visible to List");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
