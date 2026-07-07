import {
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { RemoteOp, RemoteSnapshot, S3SyncSettings } from "./types";
import {
  arrayBufferToText,
  bodyToArrayBuffer,
  encodePathForKey,
  normalizePrefix,
  textToArrayBuffer,
} from "./utils";

export class S3Remote {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(settings: S3SyncSettings) {
    this.bucket = settings.bucket.trim();
    this.prefix = normalizePrefix(settings.prefix);
    this.client = new S3Client({
      endpoint: settings.endpoint.trim(),
      region: settings.region.trim() || "us-east-1",
      forcePathStyle: settings.forcePathStyle,
      credentials: {
        accessKeyId: settings.accessKeyId.trim(),
        secretAccessKey: settings.secretAccessKey,
      },
    });
  }

  validate(): void {
    if (!this.bucket) {
      throw new Error("请先填写 S3 Bucket");
    }
  }

  objectKeyForHash(hash: string): string {
    return `${this.prefix}objects/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
  }

  async uploadObject(hash: string, data: ArrayBuffer): Promise<string> {
    const key = this.objectKeyForHash(hash);
    await this.putBytes(key, data, "application/octet-stream");
    return key;
  }

  async downloadObject(objectKey: string): Promise<ArrayBuffer> {
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
    }));
    return bodyToArrayBuffer(response.Body);
  }

  async appendOp(op: RemoteOp): Promise<void> {
    // 每个操作写入唯一对象，避免多个设备同时覆盖同一个 manifest。
    const key = `${this.prefix}ops/${op.opId}.json`;
    await this.putJson(key, op);
  }

  async listOpsAfter(cursor: string | null): Promise<RemoteOp[]> {
    const prefix = `${this.prefix}ops/`;
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));

      for (const item of response.Contents ?? []) {
        if (item.Key) {
          keys.push(item.Key);
        }
      }
      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    const sorted = keys.sort();
    const filtered = cursor ? sorted.filter((key) => this.opIdFromKey(key) > cursor) : sorted;
    const ops: RemoteOp[] = [];

    for (const key of filtered) {
      const op = await this.getJson<RemoteOp>(key);
      ops.push(op);
    }

    return ops.sort((a, b) => a.opId.localeCompare(b.opId));
  }

  async testConnection(): Promise<void> {
    this.validate();
    await this.client.send(new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: this.prefix,
      MaxKeys: 1,
    }));
  }

  async readSnapshot(): Promise<RemoteSnapshot | null> {
    const key = `${this.prefix}snapshots/latest.json`;
    try {
      return await this.getJson<RemoteSnapshot>(key);
    } catch (error) {
      if (this.isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async writeSnapshot(snapshot: RemoteSnapshot): Promise<void> {
    await this.putJson(`${this.prefix}snapshots/latest.json`, snapshot);
  }

  private async putJson(key: string, value: unknown): Promise<void> {
    const body = textToArrayBuffer(JSON.stringify(value, null, 2));
    await this.putBytes(key, body, "application/json; charset=utf-8");
  }

  private async getJson<T>(key: string): Promise<T> {
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
    const body = await bodyToArrayBuffer(response.Body);
    return JSON.parse(arrayBufferToText(body)) as T;
  }

  private async putBytes(key: string, body: ArrayBuffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: new Uint8Array(body),
      ContentType: contentType,
    }));
  }

  private opIdFromKey(key: string): string {
    return key.slice(`${this.prefix}ops/`.length).replace(/\.json$/, "");
  }

  private isNotFound(error: unknown): boolean {
    return error instanceof NoSuchKey || (error as { name?: string }).name === "NoSuchKey";
  }
}

export function remotePathKey(path: string): string {
  return encodePathForKey(path);
}
