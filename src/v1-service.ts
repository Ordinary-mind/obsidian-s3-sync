import { S3ObjectStore } from "../adapters/s3-object-store";
import { discoverRepositoryDescriptors } from "../core/discovery";
import type { S3SyncSettings } from "./types";

export class V1RepositoryService {
  constructor(private readonly settings: S3SyncSettings) {}
  async discover(): Promise<Array<{ key: string; repositoryId: string; descriptorHash: string }>> {
    const store = new S3ObjectStore({ endpoint: this.settings.endpoint, region: this.settings.region, bucket: this.settings.bucket, forcePathStyle: this.settings.forcePathStyle, credentials: { accessKeyId: this.settings.accessKeyId, secretAccessKey: this.settings.secretAccessKey } });
    return discoverRepositoryDescriptors(store, this.settings.prefix);
  }
}
