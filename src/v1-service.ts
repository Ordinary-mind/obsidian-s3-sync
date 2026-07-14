import { S3ObjectStore } from "../adapters/s3-object-store";
import { discoverRepositoryDescriptors } from "../core/discovery";
import { InMemoryRepositoryCore } from "../core/repository";
import { pullCommitIntoRepository, pullCommitSetIntoRepository } from "../core/remote-pull";
import { createRepositoryDescriptor, readRepositoryDescriptorAnchor } from "../core/repository-bootstrap";
import { probeWritableObjectStore } from "../core/connection-probe";
import { buildVaultPutPublishEnvelope } from "../core/vault-publish-envelope";
import { publishEnvelope } from "../core/remote-publish";
import { downloadVerifiedBlob } from "../core/remote-blob";
import { resolveVaultBlobDependencies } from "../core/remote-dependencies";
import type { StableCapture } from "../core/stable-capture";
import { createRepositoryLocator, repositoryFingerprint, type RepositoryLocator } from "../core/locator";
import { assertDescriptorDirectoryBinding, type PersistedRepositoryBinding } from "../core/repository-binding";
import { verifyWriterFrontiers, type CommitFrontierAnchor, type WriterFrontiers } from "../core/commit-frontier";
import type { S3SyncSettings } from "./types";
import type { VerifiedRegisterObservation as RemoteRegisterObservation } from "../core/remote-merge-state";
import { auditRemoteRepository } from "../core/remote-audit";
import { canonicalizeProtocolJson } from "../protocol/json";
import { sha256Hex } from "../protocol/hash";
import { parseVersionId } from "../core/version-id";
import type { ProtocolConfigTree } from "../core/config-tree";
import type { CommitKind } from "../core/types";
import { buildConfigSnapshotPublishEnvelope } from "../core/config-publish-envelope";
import { replayFrozenDurableOutbox, type DurableOutboxEntry, type DurableOutboxReplaySource } from "../core/durable-outbox";
import { readObjectBytes } from "../core/object-store";

export interface V1ConfigHead {
  versionId: string;
  treeHash: string;
  writerId: string;
  tree: ProtocolConfigTree;
  bytesByPath: Map<string, Uint8Array>;
  blockedDependencies: Array<{ path: string; reason: unknown }>;
}

export interface V1ConfigInspection {
  disposition: "empty" | "resolved" | "conflict" | "pending" | "invalid";
  heads: V1ConfigHead[];
  headVersionIds: string[];
  pendingVersionIds: string[];
  invalidVersionIds: string[];
  blockedCommitKeys: Array<{ key: string; reason: unknown }>;
  acceptedCommits: CommitFrontierAnchor[];
  observations: RemoteRegisterObservation[];
}

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
  async assertDescriptorBinding(
    repositoryId: string,
    descriptorHash: string,
    binding: Pick<PersistedRepositoryBinding, "configDir" | "historicalConfigDirs">,
  ): Promise<void> {
    assertDescriptorDirectoryBinding(binding, await this.requireDescriptor(repositoryId, descriptorHash));
  }
  async verifyFrontierAnchor(repositoryId: string, descriptorHash: string, anchor: CommitFrontierAnchor): Promise<void> {
    await this.requireDescriptor(repositoryId, descriptorHash);
    await verifyWriterFrontiers(this.store(), repositoryId, descriptorHash, { [anchor.writerId]: [anchor] });
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
    writerFrontiers: WriterFrontiers;
  }): Promise<CommitFrontierAnchor> {
    await this.requireDescriptor(input.repositoryId, input.descriptorHash);
    await verifyWriterFrontiers(this.store(), input.repositoryId, input.descriptorHash, input.writerFrontiers);
    const envelope = buildVaultPutPublishEnvelope({ ...input, prefix: this.prefix });
    await publishEnvelope(this.store(), envelope);
    return {
      key: envelope.commit.key,
      writerId: input.writerId,
      sequence: input.sequence,
      hash: envelope.commit.hash,
      previousCommitHash: input.previousCommitHash,
    };
  }
  async resolvedVaultHeads(repositoryId: string, descriptorHash: string, path: string): Promise<string[]> {
    const repository = await this.pullAllCommits(repositoryId, descriptorHash);
    const state = repository.register(repositoryId, "vault", path);
    if (state.disposition !== "resolved") throw new Error(`cannot publish ${path}: remote register is ${state.disposition}`);
    return state.heads;
  }
  async resolvedVaultPut(repositoryId: string, descriptorHash: string, path: string): Promise<{ heads: string[]; hash: string } | undefined> {
    return (await this.resolvedVaultPutWithAnchors(repositoryId, descriptorHash, path)).value;
  }
  async resolvedVaultPutWithAnchors(repositoryId: string, descriptorHash: string, path: string): Promise<{
    value: { heads: string[]; hash: string } | undefined;
    acceptedCommits: CommitFrontierAnchor[];
    observations: RemoteRegisterObservation[];
  }> {
    const pulled = await this.pullAllCommitsWithAnchors(repositoryId, descriptorHash);
    const repository = pulled.repository;
    const state = repository.register(repositoryId, "vault", path);
    if (state.disposition !== "resolved") throw new Error(`cannot publish ${path}: remote register is ${state.disposition}`);
    const observations = registerObservations(repository, repositoryId);
    if (state.heads.length === 0) return { value: undefined, acceptedCommits: pulled.acceptedCommits, observations };
    const version = repository.version(state.heads[0]);
    return { value: version?.blob ? { heads: state.heads, hash: version.blob.hash } : undefined, acceptedCommits: pulled.acceptedCommits, observations };
  }
  async listResolvedVaultPuts(repositoryId: string, descriptorHash: string): Promise<Array<{ path: string; hash: string; size: number; bytes: Uint8Array; heads: string[] }>> {
    return (await this.listResolvedVaultPutsWithDiagnostics(repositoryId, descriptorHash)).files;
  }
  async listResolvedVaultPutsWithDiagnostics(repositoryId: string, descriptorHash: string): Promise<{
    files: Array<{ path: string; hash: string; size: number; bytes: Uint8Array; heads: string[] }>;
    blocked: Array<{ path: string; heads: string[]; reason: unknown }>;
    blockedCommitKeys: Array<{ key: string; reason: unknown }>;
    acceptedCommits: CommitFrontierAnchor[];
    observations: RemoteRegisterObservation[];
  }> {
    const pulled = await this.pullAllCommitsWithDiagnostics(repositoryId, descriptorHash);
    const repository = pulled.repository;
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
      blockedCommitKeys: pulled.blockedCommitKeys,
      acceptedCommits: pulled.acceptedCommits,
      observations: registerObservations(repository, repositoryId),
    };
  }
  async inspectConfigRegister(repositoryId: string, descriptorHash: string): Promise<V1ConfigInspection> {
    const pulled = await this.pullAllCommitsWithDiagnostics(repositoryId, descriptorHash);
    const register = pulled.repository.register(repositoryId, "config", "portable");
    const writersByCommit = new Map(pulled.acceptedCommits.map((anchor) => [anchor.hash, anchor.writerId]));
    const heads: V1ConfigHead[] = [];
    let dependencyBlocked = false;
    for (const versionId of register.heads) {
      const version = pulled.repository.version(versionId);
      const tree = version?.configTree as ProtocolConfigTree | undefined;
      if (!tree || tree.protocol !== 1 || tree.repositoryId !== repositoryId || tree.descriptorHash !== descriptorHash) {
        dependencyBlocked = true;
        continue;
      }
      const treeHash = configTreeHash(tree);
      const bytesByPath = new Map<string, Uint8Array>();
      const blockedDependencies: Array<{ path: string; reason: unknown }> = [];
      for (const item of tree.items) {
        if (item.kind !== "put") continue;
        if (!item.blobHash || item.size === undefined) {
          blockedDependencies.push({ path: item.path, reason: new Error("ConfigTree put is missing its Blob reference") });
          continue;
        }
        try {
          bytesByPath.set(item.path, await downloadVerifiedBlob(this.store(), this.prefix, repositoryId, { hash: item.blobHash, size: item.size }));
        } catch (reason) {
          blockedDependencies.push({ path: item.path, reason });
        }
      }
      if (blockedDependencies.length > 0) dependencyBlocked = true;
      const commitHash = parseVersionId(versionId).commitHash;
      heads.push({
        versionId,
        treeHash,
        writerId: writersByCommit.get(commitHash) ?? "unknown",
        tree: structuredClone(tree),
        bytesByPath,
        blockedDependencies,
      });
    }
    const uniqueTreeHashes = new Set(heads.map((head) => head.treeHash));
    let disposition: V1ConfigInspection["disposition"];
    if (register.invalid.length > 0) disposition = "invalid";
    else if (register.pending.length > 0 || pulled.blockedCommitKeys.length > 0 || dependencyBlocked || heads.length !== register.heads.length) disposition = "pending";
    else if (register.heads.length === 0) disposition = "empty";
    else if (uniqueTreeHashes.size === 1) disposition = "resolved";
    else disposition = "conflict";
    return {
      disposition,
      heads: heads.sort((left, right) => compareUtf8(left.versionId, right.versionId)),
      headVersionIds: [...register.heads],
      pendingVersionIds: [...register.pending],
      invalidVersionIds: [...register.invalid],
      blockedCommitKeys: pulled.blockedCommitKeys,
      acceptedCommits: pulled.acceptedCommits,
      observations: registerObservations(pulled.repository, repositoryId),
    };
  }
  async publishConfigSnapshot(input: {
    repositoryId: string;
    descriptorHash: string;
    writerId: string;
    sequence: string;
    previousCommitHash: string | null;
    createdAt: string;
    clientVersion: string;
    parents: string[];
    tree: ProtocolConfigTree;
    bytesByPath: ReadonlyMap<string, Uint8Array>;
    writerFrontiers: WriterFrontiers;
    kind?: CommitKind;
  }): Promise<CommitFrontierAnchor & { treeHash: string; versionId: string }> {
    const binding = await this.requireDescriptor(input.repositoryId, input.descriptorHash);
    await verifyWriterFrontiers(this.store(), input.repositoryId, input.descriptorHash, input.writerFrontiers);
    const publication = buildConfigSnapshotPublishEnvelope({
      prefix: this.prefix,
      repositoryId: input.repositoryId,
      descriptorHash: input.descriptorHash,
      writerId: input.writerId,
      sequence: input.sequence,
      previousCommitHash: input.previousCommitHash,
      createdAt: input.createdAt,
      clientVersion: input.clientVersion,
      kind: input.kind,
      parents: input.parents,
      tree: input.tree,
      bytesByPath: input.bytesByPath,
      binding,
    });
    await publishEnvelope(this.store(), publication.envelope);
    return {
      key: publication.envelope.commit.key,
      writerId: input.writerId,
      sequence: input.sequence,
      hash: publication.envelope.commit.hash,
      previousCommitHash: input.previousCommitHash,
      treeHash: publication.treeHash,
      versionId: publication.versionId,
    };
  }
  async replayDurableOutbox(input: {
    repositoryId: string;
    descriptorHash: string;
    entry: DurableOutboxEntry;
    source: DurableOutboxReplaySource;
    writerFrontiers: WriterFrontiers;
  }): Promise<CommitFrontierAnchor> {
    await this.requireDescriptor(input.repositoryId, input.descriptorHash);
    const store = this.store();
    await verifyWriterFrontiers(store, input.repositoryId, input.descriptorHash, input.writerFrontiers);
    await replayFrozenDurableOutbox(input.entry, input.source, {
      repositoryFingerprint: repositoryFingerprint(this.locator, input.repositoryId, input.descriptorHash),
      putImmutable: async (object, body) => {
        await store.putImmutable(object.key, await readReplayBody(body, object.hash, object.size));
      },
      verifyRemote: async (object) => {
        const bytes = await readObjectBytes(store, object.key, { maximumBytes: object.size, expectedHash: object.hash });
        if (bytes.byteLength !== object.size) throw new Error(`remote durable Outbox ${object.kind} size integrity mismatch`);
      },
    });
    const commit = input.entry.objects.at(-1)!;
    return {
      key: commit.key,
      writerId: input.entry.writerId,
      sequence: input.entry.sequence,
      hash: input.entry.commitHash,
      previousCommitHash: input.entry.previousCommitHash,
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
  async pullAllCommitsWithDiagnostics(repositoryId: string, descriptorHash: string): Promise<{
    repository: InMemoryRepositoryCore;
    blockedCommitKeys: Array<{ key: string; reason: unknown }>;
    acceptedCommits: CommitFrontierAnchor[];
  }> {
    const descriptor = await this.requireDescriptor(repositoryId, descriptorHash);
    return pullCommitSetIntoRepository(this.store(), this.prefix, repositoryId, descriptorHash, await this.listCommitKeys(repositoryId), descriptor);
  }
  private async pullAllCommitsWithAnchors(repositoryId: string, descriptorHash: string): Promise<{
    repository: InMemoryRepositoryCore;
    acceptedCommits: CommitFrontierAnchor[];
  }> {
    const pulled = await this.pullAllCommitsWithDiagnostics(repositoryId, descriptorHash);
    if (pulled.blockedCommitKeys.length > 0) throw pulled.blockedCommitKeys[0].reason;
    return { repository: pulled.repository, acceptedCommits: pulled.acceptedCommits };
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
  async fullAudit(
    repositoryId: string,
    descriptorHash: string,
    onProgress?: (progress: { completedObjects: number; totalObjects: number; missingClosure: string[] }) => void,
  ): Promise<{ verifiedObjects: number; totalObjects: number; missingClosure: string[]; commits: number; registers: number }> {
    const result = await auditRemoteRepository(this.store(), this.prefix, repositoryId, descriptorHash, { onProgress });
    return {
      verifiedObjects: result.verifiedObjects,
      totalObjects: result.totalObjects,
      missingClosure: [...result.missingClosure],
      commits: result.commitKeys.length,
      registers: result.repository.allRegisters(repositoryId).size,
    };
  }
  private store(): S3ObjectStore {
    return new S3ObjectStore({ endpoint: this.locator.endpoint, region: this.locator.region, bucket: this.locator.bucket, forcePathStyle: this.locator.forcePathStyle, credentials: { accessKeyId: this.settings.accessKeyId, secretAccessKey: this.settings.secretAccessKey } });
  }
  private async requireDescriptor(repositoryId: string, descriptorHash: string): Promise<{ configDir: string; historicalConfigDirs: string[] }> {
    return readRepositoryDescriptorAnchor(this.store(), this.prefix, repositoryId, descriptorHash);
  }
}

function registerObservations(repository: InMemoryRepositoryCore, repositoryId: string): RemoteRegisterObservation[] {
  return [...repository.allRegisters(repositoryId)].map(([key, state]) => {
    const version = state.disposition === "resolved" && state.heads.length === 1 ? repository.version(state.heads[0]) : undefined;
    const configValueHash = version?.channel === "config" && version.configTree
      ? configTreeHash(version.configTree as ProtocolConfigTree)
      : undefined;
    return {
      key,
      heads: [...state.heads],
      pending: [...state.pending],
      invalid: [...state.invalid],
      disposition: state.disposition,
      ...(version ? { valueHash: configValueHash ?? version.blob?.hash ?? null } : {}),
    };
  }).sort((left, right) => left.key.localeCompare(right.key));
}

function configTreeHash(tree: ProtocolConfigTree): string {
  return sha256Hex(new TextEncoder().encode(canonicalizeProtocolJson(tree)));
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder(); const a = encoder.encode(left); const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return a.length - b.length;
}

async function readReplayBody(body: AsyncIterable<Uint8Array>, expectedHash: string, expectedSize: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > expectedSize) throw new Error("durable Outbox replay size integrity mismatch");
    chunks.push(new Uint8Array(chunk));
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (size !== expectedSize || sha256Hex(bytes) !== expectedHash) throw new Error("durable Outbox replay content integrity mismatch");
  return bytes;
}
