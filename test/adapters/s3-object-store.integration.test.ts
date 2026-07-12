import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { S3ObjectStore } from "../../adapters/s3-object-store";

const text = new TextEncoder();
const decode = new TextDecoder();

describe("S3 ObjectStore contract", () => {
  const store = new S3ObjectStore({
    endpoint: process.env.S3_ENDPOINT!,
    region: process.env.S3_REGION!,
    bucket: process.env.S3_BUCKET!,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
  });
  const prefix = `contract/${randomUUID()}/`;
  const key = `${prefix}immutable.json`;
  const bytes = text.encode('{"source":"minio-contract"}');

  it("writes immutable bytes, reads them back, lists the key, and rejects a duplicate write", async () => {
    await store.putImmutable(key, bytes);
    await expect(store.head(key)).resolves.toEqual({ size: bytes.byteLength });
    await expect(store.get(key)).resolves.toSatisfy((value: Uint8Array) => decode.decode(value) === decode.decode(bytes));
    await expect(store.list(prefix)).resolves.toMatchObject({ keys: [key] });
    await expect(store.putImmutable(key, text.encode("different bytes"))).rejects.toBeDefined();
  });
});
