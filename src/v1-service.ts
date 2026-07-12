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
  async listCommitKeys(repositoryId: string): Promise<string[]> {
    const root = [this.settings.prefix.replace(/\/$/, ""), `.obsidian-s3-sync/v1/repositories/${repositoryId}/commits/`].filter(Boolean).join("/");
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.store().list(root, token);
      keys.push(...page.keys.filter((key) => key.startsWith(root) && key.endsWith(".json")));
      token = page.continuationToken;
    } while (token);
    return [...new Set(keys)].sort();
  }
  async pullAllCommits(repositoryId: string, descriptorHash: string): Promise<InMemoryRepositoryCore> {
    const repository = new InMemoryRepositoryCore();
    for (const key of await this.listCommitKeys(repositoryId)) await this.pullCommit(repositoryId, descriptorHash, key, repository);
    return repository;
  }
  private store(): S3ObjectStore {
    return new S3ObjectStore({ endpoint: this.settings.endpoint, region: this.settings.region, bucket: this.settings.bucket, forcePathStyle: this.settings.forcePathStyle, credentials: { accessKeyId: this.settings.accessKeyId, secretAccessKey: this.settings.secretAccessKey } });
  }
}
