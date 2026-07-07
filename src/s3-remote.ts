import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { normalizePath } from "obsidian";
import type { RemoteManifest, S3SyncSettings } from "./types";
import {
  arrayBufferToText,
  bodyToArrayBuffer,
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

  manifestKey(): string {
    return `${this.prefix}.s3-sync/manifest.json`;
  }

  fileKey(path: string): string {
    return `${this.prefix}${normalizePath(path)}`;
  }

  async testConnection(): Promise<void> {
    this.validate();
    await this.client.send(new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: this.prefix,
      MaxKeys: 1,
    }));
  }

  async readManifest(): Promise<RemoteManifest> {
    try {
      return await this.getJson<RemoteManifest>(this.manifestKey());
    } catch (error) {
      if (this.isNotFound(error)) {
        return {
          version: 0,
          updatedAt: new Date().toISOString(),
          files: {},
        };
      }
      throw error;
    }
  }

  async writeManifest(manifest: RemoteManifest): Promise<void> {
    await this.putJson(this.manifestKey(), manifest);
  }

  async uploadFile(path: string, data: ArrayBuffer): Promise<void> {
    await this.putBytes(this.fileKey(path), data, "application/octet-stream");
  }

  async downloadFile(path: string): Promise<ArrayBuffer> {
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.fileKey(path),
    }));
    return bodyToArrayBuffer(response.Body);
  }

  async deleteFile(path: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: this.fileKey(path),
    }));
  }

  async deletePrefix(): Promise<number> {
    this.validate();
    let deleted = 0;
    let continuationToken: string | undefined;

    do {
      const response = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.prefix,
        ContinuationToken: continuationToken,
      }));

      const objects = (response.Contents ?? [])
        .map((item) => item.Key)
        .filter((key): key is string => Boolean(key))
        .map((Key) => ({ Key }));

      if (objects.length > 0) {
        await this.client.send(new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: {
            Objects: objects,
            Quiet: true,
          },
        }));
        deleted += objects.length;
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return deleted;
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

  private isNotFound(error: unknown): boolean {
    return error instanceof NoSuchKey || (error as { name?: string }).name === "NoSuchKey";
  }
}
