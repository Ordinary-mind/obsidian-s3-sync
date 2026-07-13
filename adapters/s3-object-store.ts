import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { ObjectStore } from "../core/object-store";
import type { RepositoryEndpoint } from "../core/locator";

export interface S3ObjectStoreOptions extends RepositoryEndpoint {
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  constructor(private readonly options: S3ObjectStoreOptions) {
    this.client = new S3Client({ endpoint: options.endpoint, region: options.region, forcePathStyle: options.forcePathStyle, credentials: options.credentials });
  }
  async list(prefix: string, continuationToken?: string): Promise<{ keys: string[]; continuationToken?: string }> {
    const result = await this.client.send(new ListObjectsV2Command({ Bucket: this.options.bucket, Prefix: prefix, ContinuationToken: continuationToken }));
    return { keys: (result.Contents ?? []).flatMap((entry) => entry.Key ? [entry.Key] : []), continuationToken: result.NextContinuationToken };
  }
  async get(key: string): Promise<Uint8Array> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }));
    if (!result.Body) throw new Error("S3 GetObject response has no body");
    return result.Body.transformToByteArray();
  }
  async head(key: string): Promise<{ size: number }> {
    const result = await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }));
    if (result.ContentLength === undefined) throw new Error("S3 HeadObject response has no ContentLength");
    return { size: result.ContentLength };
  }
  async putImmutable(key: string, bytes: Uint8Array): Promise<void> {
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.options.bucket, Key: key, Body: bytes, IfNoneMatch: "*" }));
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error;
    }

    const stored = await this.get(key);
    if (!equalBytes(stored, bytes)) throw new Error(`S3 immutable object differs for key: ${key}`);
  }
}


function isPreconditionFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return value.name === "PreconditionFailed" || value.$metadata?.httpStatusCode === 412;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}
