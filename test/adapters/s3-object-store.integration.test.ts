import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { S3ObjectStore } from "../../adapters/s3-object-store";
import { readObjectBytes } from "../../core/object-store";

const text = new TextEncoder();
const decode = new TextDecoder();

describe(`${process.env.S3_TEST_PROVIDER ?? "S3"} ObjectStore contract`, () => {
  const store = new S3ObjectStore({
    endpoint: process.env.S3_ENDPOINT!,
    region: process.env.S3_REGION!,
    bucket: process.env.S3_BUCKET!,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
      sessionToken: process.env.S3_SESSION_TOKEN || undefined,
    },
  });
  const prefix = `contract/${randomUUID()}/`;
  const key = `${prefix}immutable.json`;
  const firstBytes = text.encode('{"source":"first-writer"}');
  const secondBytes = text.encode('{"source":"second-writer"}');

  it("allows exactly one concurrent immutable write and preserves its bytes", async () => {
    const writes = await Promise.allSettled([
      store.putImmutable(key, firstBytes),
      store.putImmutable(key, secondBytes),
    ]);
    expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1);

    const stored = await readObjectBytes(store, key);
    const storedText = decode.decode(stored);
    expect([decode.decode(firstBytes), decode.decode(secondBytes)]).toContain(storedText);
    await expect(store.head(key)).resolves.toEqual({ size: stored.byteLength });
    await expect(store.list(prefix)).resolves.toMatchObject({ keys: [key] });
    await expect(store.putImmutable(key, stored)).resolves.toBeUndefined();
    await expect(store.putImmutable(key, text.encode('{"source":"different"}')))
      .rejects.toMatchObject({ kind: "integrity", operation: "put" });
  });
});
