import { S3ObjectStore } from "../adapters/s3-object-store";
import { discoverRepositoryDescriptors } from "../core/discovery";
import { InMemoryRepositoryCore } from "../core/repository";
import { pullCommitIntoRepository } from "../core/remote-pull";
import { createRepositoryDescriptor } from "../core/repository-bootstrap";
import { probeWritableObjectStore } from "../core/connection-probe";
import { buildVaultPutPublishEnvelope } from "../core/vault-publish-envelope";
import { publishEnvelope } from "../core/remote-publish";
import { downloadVerifiedBlob } from "../core/remote-blob";
import { resolveVaultBlobDependencies } from "../core/remote-dependencies";
import type { StableCapture } from "../core/stable-capture";
import { createRepositoryLocator, type RepositoryLocator } from "../core/locator";
import type { S3SyncSettings } from "./types";

export class V1RepositoryService {
  private readonly locator: Readonly<RepositoryLocator>;
  private readonly prefix: string;

  constructor(private readonly settings: S3SyncSettings, prefix = settings.prefix) {
    this.locator = createRepositoryLocator(
      { endpoint: settings.endpoint, region: settings.region, bucket: settings.bucket, forcePathStyle: settings.forcePathStyle, prefix },
      settings.endpoint.startsWith("http://127.0.0.1") || settings.endpoint.startsWith("http://localhost"),
    );
    this.prefix = this.locator.normalizedPrefix;
  }
  async discover(): Promise<Array<{ key: string; repositoryId: string; descriptorHash: string; configDir: string; historicalConfigDirs: string[] }>> {
    const store = this.store();
    return discoverRepositoryDescriptors(store, this.prefix);
  }
  async createRepository(repositoryId: string, configDir: string, historicalConfigDirs: string[] = []): Promise<{ repositoryId: string; descriptorHash: string; key: string }> {
    const existing = await this.discover();
    if (existing.length > 0) throw new Error("repository already exists at this Prefix; select it instead of creating another");
    return createRepositoryDescriptor(this.store(), { prefix: this.prefix, repositoryId, configDir, historicalConfigDirs });
  }
  async probeWritableConnection(probeId: string): Promise<void> {
    const key = [this.prefix.replace(/\/$/, ""), ".obsidian-s3-sync/v1/probes", `${probeId}.bin`].filter(Boolean).join("/");
    await probeWritableObjectStore(this.store(), key, new TextEncoder().encode(probeId), this.store());
  }
  async publishVaultPut(input: {
    repositoryId: string;
    descriptorHash: string;
    writerId: string;
    sequence: string;
    previousCommitHash: string | null;
    createdAt: string;
    clientVersion: string;
    path: string;
    parents: string[];
    capture: StableCapture;
  }): Promise<string> {
    await this.requireDescriptor(input.repositoryId, input.descriptorHash);
    const envelope = buildVaultPutPublishEnvelope({ ...input, prefix: this.prefix });
    await publishEnvelope(this.store(), envelope);
    return envelope.commit.hash;
  }
  async resolvedVaultHeads(repositoryId: string, descriptorHash: string, path: string): Promise<string[]> {
    const repository = await this.pullAllCommits(repositoryId, descriptorHash);
    const state = repository.register(repositoryId, "vault", path);
    if (state.disposition !== "resolved") throw new Error(`cannot publish ${path}: remote register is ${state.disposition}`);
    return state.heads;
  }
  async resolvedVaultPut(repositoryId: string, descriptorHash: string, path: string): Promise<{ heads: string[]; hash: string } | undefined> {
    const repository = await this.pullAllCommits(repositoryId, descriptorHash);
    const state = repository.register(repositoryId, "vault", path);
    if (state.disposition !== "resolved") throw new Error(`cannot publish ${path}: remote register is ${state.disposition}`);
    if (state.heads.length === 0) return undefined;
    const version = repository.version(state.heads[0]);
    return version?.blob ? { heads: state.heads, hash: version.blob.hash } : undefined;
  }
  async listResolvedVaultPuts(repositoryId: string, descriptorHash: string): Promise<Array<{ path: string; hash: string; size: number; bytes: Uint8Array; heads: string[] }>> {
    return (await this.listResolvedVaultPutsWithDiagnostics(repositoryId, descriptorHash)).files;
  }
  async listResolvedVaultPutsWithDiagnostics(repositoryId: string, descriptorHash: string): Promise<{
    files: Array<{ path: string; hash: string; size: number; bytes: Uint8Array; heads: string[] }>;
    blocked: Array<{ path: string; heads: string[]; reason: unknown }>;
  }> {
    const repository = await this.pullAllCommits(repositoryId, descriptorHash);
    const dependencies: Array<{ path: string; hash: string; size: number; heads: string[] }> = [];
    for (const [key, state] of repository.allRegisters(repositoryId)) {
      if (!key.startsWith("vault:") || state.disposition !== "resolved" || state.heads.length !== 1) continue;
      const version = repository.version(state.heads[0]);
      if (!version?.blob) continue;
      dependencies.push({ path: version.logicalKey, hash: version.blob.hash, size: version.blob.size, heads: [...state.heads] });
    }
    const result = await resolveVaultBlobDependencies(dependencies, (dependency) => downloadVerifiedBlob(this.store(), this.prefix, repositoryId, dependency));
    return {
      files: result.available.sort((left, right) => left.path.localeCompare(right.path)),
      blocked: result.blocked.sort((left, right) => left.path.localeCompare(right.path)),
    };
  }
  async pullCommit(repositoryId: string, descriptorHash: string, commitKey: string, repository = new InMemoryRepositoryCore()): Promise<InMemoryRepositoryCore> {
    const descriptor = await this.requireDescriptor(repositoryId, descriptorHash);
    await pullCommitIntoRepository(this.store(), repository, this.prefix, repositoryId, descriptorHash, commitKey, descriptor);
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
    const descriptor = await this.requireDescriptor(repositoryId, descriptorHash);
    const repository = new InMemoryRepositoryCore();
    for (const key of await this.listCommitKeys(repositoryId)) {
      await pullCommitIntoRepository(this.store(), repository, this.prefix, repositoryId, descriptorHash, key, descriptor);
    }
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
    return new S3ObjectStore({ endpoint: this.locator.endpoint, region: this.locator.region, bucket: this.locator.bucket, forcePathStyle: this.locator.forcePathStyle, credentials: { accessKeyId: this.settings.accessKeyId, secretAccessKey: this.settings.secretAccessKey } });
  }
  private async requireDescriptor(repositoryId: string, descriptorHash: string): Promise<{ configDir: string; historicalConfigDirs: string[] }> {
    const candidates = (await this.discover()).filter((descriptor) => descriptor.repositoryId === repositoryId);
    if (candidates.length !== 1 || candidates[0].descriptorHash !== descriptorHash) {
      throw new Error("repository descriptor changed or is no longer readable");
    }
    return { configDir: candidates[0].configDir, historicalConfigDirs: [...candidates[0].historicalConfigDirs] };
  }
}
