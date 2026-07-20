import { S3ObjectStore, type S3ObjectStoreMetrics } from "../adapters/s3-object-store";
import { discoverRepositoryDescriptors } from "../core/discovery";
import { InMemoryRepositoryCore } from "../core/repository";
import { pullCommitIntoRepository, pullCommitSetIntoRepository } from "../core/remote-pull";
import { createRepositoryDescriptor, readRepositoryDescriptorAnchor } from "../core/repository-bootstrap";
import { probeWritableObjectStore } from "../core/connection-probe";
import { buildVaultPutPublishEnvelope } from "../core/vault-publish-envelope";
import { publishEnvelope } from "../core/remote-publish";
import { downloadVerifiedBlob, verifyRemoteBlob } from "../core/remote-blob";
import { verifyVaultBlobDependencies } from "../core/remote-dependencies";
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
import {
  replayFrozenDurableOutbox,
  withDurableOutboxReplayStage,
  type DurableOutboxEntry,
  type DurableOutboxReplaySource,
  type VerifiedTerminalOutboxProof,
} from "../core/durable-outbox";
import { ObjectStoreError, readObjectBytes, repeatedContinuationTokenError, verifyObjectStream } from "../core/object-store";
import { verifyBlobWithAdvisoryCache, type BlobExistenceCacheEntry } from "../core/blob-existence-cache";
import { repositoryPerformanceProfile } from "../core/performance-profile";
import { DiagnosticError } from "../core/diagnostics";
import {
  inspectRemoteVaultRegister,
  listRemoteVaultConflicts,
  type RemoteVaultRegisterSnapshot,
} from "../core/remote-vault-conflict";
import {
  calculateRepositorySpaceStatistics,
  listRepositoryProtocolObjects,
  repositoryObjectReachability,
  type RepositoryRequestCounts,
  type RepositorySpaceStatistics,
} from "../core/repository-statistics";
import { compareUtf8 } from "../protocol/utf8";

const REPOSITORY_TRANSFER_CONCURRENCY = repositoryPerformanceProfile.downloadConcurrency;
const DEFAULT_REQUEST_PRICING = Object.freeze({ currency: "USD", list: 0.005, get: 0.0004, put: 0.005 });

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

interface RepositoryPullCache {
  listedKeys: Set<string>;
  repository: InMemoryRepositoryCore;
  acceptedByKey: Map<string, CommitFrontierAnchor>;
  blockedByKey: Map<string, unknown>;
}

export class V1RepositoryService {
  private readonly locator: Readonly<RepositoryLocator>;
  private readonly prefix: string;
  private readonly objectStore: S3ObjectStore;
  private readonly blobExistenceCache = new Map<string, BlobExistenceCacheEntry>();
  private readonly descriptorCache = new Map<string, Promise<{ configDir: string; historicalConfigDirs: string[] }>>();
  private readonly repositoryPullCache = new Map<string, RepositoryPullCache>();

  constructor(private readonly settings: S3SyncSettings, prefix = settings.prefix, signal?: AbortSignal) {
    this.locator = createRepositoryLocator(
      { endpoint: settings.endpoint, region: settings.region, bucket: settings.bucket, forcePathStyle: settings.forcePathStyle, prefix },
      settings.endpoint.startsWith("http://127.0.0.1") || settings.endpoint.startsWith("http://localhost"),
    );
    this.prefix = this.locator.normalizedPrefix;
    this.objectStore = new S3ObjectStore({
      endpoint: this.locator.endpoint,
      region: this.locator.region,
      bucket: this.locator.bucket,
      forcePathStyle: this.locator.forcePathStyle,
      credentials: { accessKeyId: this.settings.accessKeyId, secretAccessKey: this.settings.secretAccessKey },
      maximumConcurrency: REPOSITORY_TRANSFER_CONCURRENCY,
      signal,
    });
  }
  async discover(): Promise<Array<{ key: string; repositoryId: string; descriptorHash: string; configDir: string; historicalConfigDirs: string[] }>> {
    const store = this.store();
    return discoverRepositoryDescriptors(store, this.prefix);
  }
  async createRepository(repositoryId: string, configDir: string, historicalConfigDirs: string[] = []): Promise<{ repositoryId: string; descriptorHash: string; key: string }> {
    const existing = await this.discover();
    if (existing.length > 0) {
      throw new DiagnosticError(
        "REPOSITORY_ALREADY_EXISTS",
        "repository-identity",
        "repository already exists at this Prefix",
      );
    }
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
    if (state.disposition !== "resolved") {
      throw new DiagnosticError(
        "REMOTE_VAULT_REGISTER_UNRESOLVED",
        "conflict",
        "remote Vault register is not resolved",
      );
    }
    return state.heads;
  }
  async resolvedVaultPut(repositoryId: string, descriptorHash: string, path: string): Promise<{ heads: string[]; hash: string; size: number } | undefined> {
    return (await this.resolvedVaultPutWithAnchors(repositoryId, descriptorHash, path)).value;
  }
  async resolvedVaultPutWithAnchors(repositoryId: string, descriptorHash: string, path: string): Promise<{
    value: { heads: string[]; hash: string; size: number } | undefined;
    acceptedCommits: CommitFrontierAnchor[];
    observations: RemoteRegisterObservation[];
  }> {
    const pulled = await this.inspectVaultRegisterWithAnchors(repositoryId, descriptorHash, path);
    if (pulled.register.disposition !== "resolved") {
      throw new DiagnosticError(
        "REMOTE_VAULT_REGISTER_UNRESOLVED",
        "conflict",
        "remote Vault register is not resolved",
      );
    }
    const candidate = pulled.register.candidates[0];
    return {
      value: candidate?.kind === "put"
        ? { heads: pulled.register.heads, hash: candidate.hash, size: candidate.size }
        : undefined,
      acceptedCommits: pulled.acceptedCommits,
      observations: pulled.observations,
    };
  }
  async inspectVaultRegisterWithAnchors(repositoryId: string, descriptorHash: string, path: string): Promise<{
    register: RemoteVaultRegisterSnapshot;
    acceptedCommits: CommitFrontierAnchor[];
    observations: RemoteRegisterObservation[];
  }> {
    const pulled = await this.pullAllCommitsWithAnchors(repositoryId, descriptorHash);
    return {
      register: inspectRemoteVaultRegister(pulled.repository, repositoryId, path),
      acceptedCommits: pulled.acceptedCommits,
      observations: registerObservations(pulled.repository, repositoryId),
    };
  }
  async inspectRepositoryState(repositoryId: string, descriptorHash: string): Promise<{
    blockedCommitKeys: Array<{ key: string; reason: unknown }>;
    acceptedCommits: CommitFrontierAnchor[];
    observations: RemoteRegisterObservation[];
  }> {
    const pulled = await this.pullAllCommitsWithDiagnostics(repositoryId, descriptorHash);
    return {
      blockedCommitKeys: pulled.blockedCommitKeys,
      acceptedCommits: pulled.acceptedCommits,
      observations: registerObservations(pulled.repository, repositoryId),
    };
  }
  async listResolvedVaultPuts(repositoryId: string, descriptorHash: string): Promise<Array<{ path: string; hash: string; size: number; bytes: Uint8Array; heads: string[] }>> {
    const listed = await this.listResolvedVaultPutsWithDiagnostics(repositoryId, descriptorHash);
    const files = [];
    for (const file of listed.files) {
      files.push({ ...file, bytes: await this.downloadVaultBlob(repositoryId, file) });
    }
    return files;
  }
  async listResolvedVaultPutsWithDiagnostics(repositoryId: string, descriptorHash: string): Promise<{
    files: Array<{ path: string; hash: string; size: number; heads: string[] }>;
    blocked: Array<{ path: string; heads: string[]; reason: unknown }>;
    blockedCommitKeys: Array<{ key: string; reason: unknown }>;
    conflicts: RemoteVaultRegisterSnapshot[];
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
    const store = this.store();
    const result = await verifyVaultBlobDependencies(
      dependencies,
      (dependency, signal) => verifyRemoteBlob(store, this.prefix, repositoryId, dependency, { signal }),
      { concurrency: REPOSITORY_TRANSFER_CONCURRENCY },
    );
    return {
      files: result.available.sort((left, right) => compareUtf8(left.path, right.path)),
      blocked: result.blocked.sort((left, right) => compareUtf8(left.path, right.path)),
      blockedCommitKeys: pulled.blockedCommitKeys,
      conflicts: listRemoteVaultConflicts(repository, repositoryId),
      acceptedCommits: pulled.acceptedCommits,
      observations: registerObservations(repository, repositoryId),
    };
  }
  async downloadVaultBlob(repositoryId: string, blob: { hash: string; size: number }): Promise<Uint8Array> {
    return downloadVerifiedBlob(this.store(), this.prefix, repositoryId, blob);
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
    try {
      await this.requireDescriptor(input.repositoryId, input.descriptorHash);
    } catch (error) {
      throw withDurableOutboxReplayStage("descriptor", error);
    }
    const store = this.store();
    try {
      await verifyWriterFrontiers(store, input.repositoryId, input.descriptorHash, input.writerFrontiers);
    } catch (error) {
      throw withDurableOutboxReplayStage("frontier", error);
    }
    await replayFrozenDurableOutbox(input.entry, input.source, {
      repositoryFingerprint: repositoryFingerprint(this.locator, input.repositoryId, input.descriptorHash),
      isRemoteVerified: async (object) => remoteObjectIsVerified(store, object),
      putImmutable: async (object, openBody) => {
        const publish = async (): Promise<void> => {
          if (store.putImmutableStream) {
            await store.putImmutableStream(object.key, openBody, { hash: object.hash, size: object.size });
            return;
          }
          await store.putImmutable(object.key, await readReplayBody(await openBody(), object.hash, object.size));
        };
        if (object.kind !== "blob") {
          await publish();
          return;
        }
        await verifyBlobWithAdvisoryCache({
          hash: object.hash,
          size: object.size,
          cache: {
            get: async (hash) => this.blobExistenceCache.get(hash),
            set: async (entry) => { this.blobExistenceCache.set(entry.hash, entry); },
            delete: async (hash) => { this.blobExistenceCache.delete(hash); },
          },
          now: Date.now(),
          verifyRemote: async () => remoteObjectIsVerified(store, object),
          publishImmutable: publish,
        });
      },
      verifyRemote: async (object) => {
        await verifyObjectStream(store, object.key, { hash: object.hash, size: object.size });
      },
    }, { dependencyConcurrency: REPOSITORY_TRANSFER_CONCURRENCY });
    const commit = input.entry.objects.at(-1)!;
    return {
      key: commit.key,
      writerId: input.entry.writerId,
      sequence: input.entry.sequence,
      hash: input.entry.commitHash,
      previousCommitHash: input.entry.previousCommitHash,
    };
  }
  async verifyTerminalDurableOutboxRemoteCopy(input: {
    repositoryId: string;
    descriptorHash: string;
    entry: DurableOutboxEntry;
    source: DurableOutboxReplaySource;
    writerFrontiers: WriterFrontiers;
  }): Promise<{ anchor: CommitFrontierAnchor; proof: VerifiedTerminalOutboxProof }> {
    if (input.entry.state !== "integrity-error" && input.entry.state !== "recovery-required") {
      throw new DiagnosticError(
        "TERMINAL_OUTBOX_STATE_INVALID",
        "integrity",
        "terminal durable Outbox verification requires a terminal entry",
      );
    }
    try {
      if (input.entry.repositoryFingerprint !== repositoryFingerprint(this.locator, input.repositoryId, input.descriptorHash)) {
        throw new DiagnosticError(
          "TERMINAL_OUTBOX_REPOSITORY_MISMATCH",
          "repository-identity",
          "terminal durable Outbox belongs to another repository binding",
        );
      }
      await this.requireDescriptor(input.repositoryId, input.descriptorHash);
    } catch (error) {
      throw withDurableOutboxReplayStage("descriptor", error);
    }
    const store = this.store();
    try {
      await verifyWriterFrontiers(store, input.repositoryId, input.descriptorHash, input.writerFrontiers);
    } catch (error) {
      throw withDurableOutboxReplayStage("frontier", error);
    }
    await replayFrozenDurableOutbox(input.entry, input.source, {
      repositoryFingerprint: repositoryFingerprint(this.locator, input.repositoryId, input.descriptorHash),
      isRemoteVerified: async (object) => remoteObjectIsVerified(store, object),
      putImmutable: async (object, openBody) => {
        if (store.putImmutableStream) {
          await store.putImmutableStream(object.key, openBody, { hash: object.hash, size: object.size });
          return;
        }
        await store.putImmutable(object.key, await readReplayBody(await openBody(), object.hash, object.size));
      },
      verifyRemote: async (object) => {
        await verifyObjectStream(store, object.key, { hash: object.hash, size: object.size });
      },
    }, { dependencyConcurrency: REPOSITORY_TRANSFER_CONCURRENCY });
    for (const object of input.entry.objects) {
      try {
        await verifyObjectStream(store, object.key, { hash: object.hash, size: object.size });
      } catch (error) {
        throw withDurableOutboxReplayStage("terminal-remote-verify", error);
      }
    }
    const commit = input.entry.objects.at(-1)!;
    return {
      anchor: {
        key: commit.key,
        writerId: input.entry.writerId,
        sequence: input.entry.sequence,
        hash: input.entry.commitHash,
        previousCommitHash: input.entry.previousCommitHash,
      },
      proof: {
        outboxId: input.entry.id,
        repositoryFingerprint: input.entry.repositoryFingerprint,
        writerId: input.entry.writerId,
        sequence: input.entry.sequence,
        previousCommitHash: input.entry.previousCommitHash,
        commitHash: input.entry.commitHash,
        objects: input.entry.objects.map(({ kind, key, hash, size }) => ({ kind, key, hash, size })),
      },
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
    const seenTokens = new Set<string>();
    do {
      const page = await this.store().list(root, token);
      keys.push(...page.keys.filter((key) => key.startsWith(root) && key.endsWith(".json")));
      token = page.continuationToken;
      if (token && seenTokens.has(token)) throw repeatedContinuationTokenError();
      if (token) seenTokens.add(token);
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
    const commitKeys = await this.listCommitKeys(repositoryId);
    const listedKeys = new Set(commitKeys);
    const cacheKey = `${repositoryId}:${descriptorHash}`;
    let cached = this.repositoryPullCache.get(cacheKey);
    if (cached && [...cached.listedKeys].some((key) => !listedKeys.has(key))) {
      this.repositoryPullCache.delete(cacheKey);
      cached = undefined;
    }
    if (!cached) {
      cached = {
        listedKeys: new Set<string>(),
        repository: new InMemoryRepositoryCore(),
        acceptedByKey: new Map<string, CommitFrontierAnchor>(),
        blockedByKey: new Map<string, unknown>(),
      };
      this.repositoryPullCache.set(cacheKey, cached);
    }
    const pullCache = cached;
    const pendingKeys = commitKeys.filter((key) => !pullCache.acceptedByKey.has(key));
    if (pendingKeys.length > 0) {
      const pulled = await pullCommitSetIntoRepository(
        this.store(),
        this.prefix,
        repositoryId,
        descriptorHash,
        pendingKeys,
        descriptor,
        { concurrency: REPOSITORY_TRANSFER_CONCURRENCY },
      );
      for (const version of pulled.repository.snapshotVersions()) pullCache.repository.ingest(version);
      for (const key of pendingKeys) pullCache.blockedByKey.delete(key);
      for (const anchor of pulled.acceptedCommits) pullCache.acceptedByKey.set(anchor.key, anchor);
      for (const blocked of pulled.blockedCommitKeys) pullCache.blockedByKey.set(blocked.key, blocked.reason);
    }
    pullCache.listedKeys = listedKeys;
    return {
      repository: pullCache.repository,
      blockedCommitKeys: commitKeys.flatMap((key) => pullCache.blockedByKey.has(key)
        ? [{ key, reason: pullCache.blockedByKey.get(key) }]
        : []),
      acceptedCommits: commitKeys.flatMap((key) => {
        const anchor = pullCache.acceptedByKey.get(key);
        return anchor ? [anchor] : [];
      }),
    };
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
    options: { signal?: AbortSignal; sliceSize?: number; yieldToIdle?: () => Promise<void> } = {},
  ): Promise<{
    verifiedObjects: number;
    totalObjects: number;
    missingClosure: string[];
    commits: number;
    registers: number;
    deletionEvidenceAllowed: true;
    space: RepositorySpaceStatistics;
  }> {
    const before = this.objectStore.metrics().operations;
    const result = await auditRemoteRepository(this.store(), this.prefix, repositoryId, descriptorHash, { onProgress, ...options });
    const objects = await listRepositoryProtocolObjects(this.store(), this.prefix, repositoryId, options);
    const reachability = repositoryObjectReachability(result, repositoryId);
    const requestCounts = operationCountDifference(before, this.objectStore.metrics().operations);
    const space = calculateRepositorySpaceStatistics({
      objects,
      ...reachability,
      logicalReferencedBytes: result.logicalReferencedBlobBytes,
      requestCounts,
      pricePerThousandRequests: DEFAULT_REQUEST_PRICING,
    });
    return {
      verifiedObjects: result.verifiedObjects,
      totalObjects: result.totalObjects,
      missingClosure: [...result.missingClosure],
      commits: result.commitKeys.length,
      registers: result.repository.allRegisters(repositoryId).size,
      deletionEvidenceAllowed: result.deletionEvidenceAllowed,
      space,
    };
  }
  performanceMetrics(): S3ObjectStoreMetrics {
    return this.objectStore.metrics();
  }
  private store(): S3ObjectStore {
    return this.objectStore;
  }
  private async requireDescriptor(repositoryId: string, descriptorHash: string): Promise<{ configDir: string; historicalConfigDirs: string[] }> {
    const cacheKey = `${repositoryId}:${descriptorHash}`;
    const cached = this.descriptorCache.get(cacheKey);
    if (cached) return cached;
    const pending = readRepositoryDescriptorAnchor(this.store(), this.prefix, repositoryId, descriptorHash);
    this.descriptorCache.set(cacheKey, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.descriptorCache.get(cacheKey) === pending) this.descriptorCache.delete(cacheKey);
      throw error;
    }
  }
}

function operationCountDifference(
  before: S3ObjectStoreMetrics["operations"],
  after: S3ObjectStoreMetrics["operations"],
): RepositoryRequestCounts {
  const difference = (operation: keyof S3ObjectStoreMetrics["operations"]): number => Math.max(0, after[operation] - before[operation]);
  return {
    list: difference("list"),
    get: difference("get") + difference("head"),
    put: difference("put"),
  };
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
  }).sort((left, right) => compareUtf8(left.key, right.key));
}

function configTreeHash(tree: ProtocolConfigTree): string {
  return sha256Hex(new TextEncoder().encode(canonicalizeProtocolJson(tree)));
}

async function readReplayBody(body: AsyncIterable<Uint8Array>, expectedHash: string, expectedSize: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > expectedSize) {
      throw new DiagnosticError(
        "DURABLE_OUTBOX_REPLAY_SIZE_MISMATCH",
        "integrity",
        "durable Outbox replay exceeded its frozen size",
      );
    }
    chunks.push(new Uint8Array(chunk));
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (size !== expectedSize || sha256Hex(bytes) !== expectedHash) {
    throw new DiagnosticError(
      "DURABLE_OUTBOX_REPLAY_CONTENT_MISMATCH",
      "integrity",
      "durable Outbox replay content does not match its frozen Hash and size",
    );
  }
  return bytes;
}

async function remoteObjectIsVerified(
  store: S3ObjectStore,
  object: { key: string; hash: string; size: number },
): Promise<boolean> {
  try {
    await verifyObjectStream(store, object.key, { hash: object.hash, size: object.size });
    return true;
  } catch (error) {
    if (error instanceof ObjectStoreError && (error.kind === "not-found" || error.kind === "integrity")) return false;
    throw error;
  }
}
