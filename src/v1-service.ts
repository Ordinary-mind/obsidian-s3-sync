import { S3ObjectStore } from "../adapters/s3-object-store";
import { discoverRepositoryDescriptors } from "../core/discovery";
import { InMemoryRepositoryCore } from "../core/repository";
import { pullCommitIntoRepository } from "../core/remote-pull";
import { createRepositoryDescriptor } from "../core/repository-bootstrap";
import { validateRepositoryEndpoint } from "../core/locator";
import type { S3SyncSettings } from "./types";

export class V1RepositoryService {
  constructor(private readonly settings: S3SyncSettings, private readonly prefix = settings.prefix) {
    if (!validateRepositoryEndpoint({ endpoint: settings.endpoint, region: settings.region, bucket: settings.bucket, forcePathStyle: settings.forcePathStyle }, settings.endpoint.startsWith("http://127.0.0.1") || settings.endpoint.startsWith("http://localhost"))) {
      throw new Error("invalid v1 repository endpoint settings");
    }
  }
  async discover(): Promise<Array<{ key: string; repositoryId: string; descriptorHash: string }>> {
    const store = this.store();
    return discoverRepositoryDescriptors(store, this.prefix);
  }
  async createRepository(repositoryId: string, configDir: string, historicalConfigDirs: string[] = []): Promise<{ repositoryId: string; descriptorHash: string; key: string }> {
    const existing = await this.discover();
    if (existing.length > 0) throw new Error("repository already exists at this Prefix; select it instead of creating another");
    return createRepositoryDescriptor(this.store(), { prefix: this.prefix, repositoryId, configDir, historicalConfigDirs });
  }
  async pullCommit(repositoryId: string, descriptorHash: string, commitKey: string, repository = new InMemoryRepositoryCore()): Promise<InMemoryRepositoryCore> {
    await pullCommitIntoRepository(this.store(), repository, this.prefix, repositoryId, descriptorHash, commitKey);
    return repository;
  }
  async listCommitKeys(repositoryId: string): Promise<string[]> {
    const root = [this.prefix.replace(/\/$/, ""), `.obsidian-s3-sync/v1/repositories/${repositoryId}/commits/`].filter(Boolean).join("/");
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
  async inspect(repositoryId: string, descriptorHash: string): Promise<{ registers: number; resolved: number; concurrent: number; pending: number; invalid: number }> {
    const repository = await this.pullAllCommits(repositoryId, descriptorHash);
    const states = [...repository.allRegisters(repositoryId).values()];
    return {
      registers: states.length,
      resolved: states.filter((state) => state.disposition === "resolved").length,
      concurrent: states.filter((state) => state.disposition === "concurrent").length,
      pending: states.filter((state) => state.disposition === "pending").length,
      invalid: states.filter((state) => state.disposition === "invalid").length,
    };
  }
  private store(): S3ObjectStore {
    return new S3ObjectStore({ endpoint: this.settings.endpoint, region: this.settings.region, bucket: this.settings.bucket, forcePathStyle: this.settings.forcePathStyle, credentials: { accessKeyId: this.settings.accessKeyId, secretAccessKey: this.settings.secretAccessKey } });
  }
}
