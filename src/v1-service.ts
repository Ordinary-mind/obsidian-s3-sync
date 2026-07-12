import { S3ObjectStore } from "../adapters/s3-object-store";
import { discoverRepositoryDescriptors } from "../core/discovery";
import { InMemoryRepositoryCore } from "../core/repository";
import { pullCommitIntoRepository } from "../core/remote-pull";
import type { S3SyncSettings } from "./types";

export class V1RepositoryService {
  constructor(private readonly settings: S3SyncSettings) {}
  async discover(): Promise<Array<{ key: string; repositoryId: string; descriptorHash: string }>> {
    const store = this.store();
    return discoverRepositoryDescriptors(store, this.settings.prefix);
  }
  async pullCommit(repositoryId: string, descriptorHash: string, commitKey: string, repository = new InMemoryRepositoryCore()): Promise<InMemoryRepositoryCore> {
    await pullCommitIntoRepository(this.store(), repository, this.settings.prefix, repositoryId, descriptorHash, commitKey);
    return repository;
  }
  private store(): S3ObjectStore {
    return new S3ObjectStore({ endpoint: this.settings.endpoint, region: this.settings.region, bucket: this.settings.bucket, forcePathStyle: this.settings.forcePathStyle, credentials: { accessKeyId: this.settings.accessKeyId, secretAccessKey: this.settings.secretAccessKey } });
  }
}
