import { blobKey, changeChunkKey, configTreeKey, descriptorKey } from "../protocol/keys";
import { canonicalizeProtocolJson } from "../protocol/json";
import type { ConfigTreeForLineage, ProtocolCommit } from "../protocol/semantics";
import { parseAndValidateKeyedCommitEnvelope, parseAndValidateProtocolObject, verifyRepositoryDescriptorAtKey } from "../protocol/validation";
import { downloadConfigTree, type ConfigTreeBinding } from "./config-tree";
import { ObjectStoreError, readObjectBytes, type ObjectStore, type ObjectStoreFailureKind, type ObjectStoreRequestOptions } from "./object-store";
import { receiveKeyedCommitBytes } from "./receive-repository";
import { verifyRemoteBlob } from "./remote-blob";
import { InMemoryRepositoryCore } from "./repository";
import type { RepositoryObjectStat } from "./repository-statistics";
import { createVersionId } from "./version-id";
import { compareUtf8 } from "../protocol/utf8";

export interface RemoteAuditResult {
  repositoryId: string;
  descriptorHash: string;
  configDir: string;
  historicalConfigDirs: string[];
  repository: InMemoryRepositoryCore;
  commitKeys: string[];
  verifiedObjects: number;
  totalObjects: number;
  missingClosure: string[];
  status: "complete";
  deletionEvidenceAllowed: true;
  reachableObjects: RepositoryObjectStat[];
  versionObjectKeys: ReadonlyMap<string, readonly string[]>;
  logicalReferencedBlobBytes: number;
}

export interface RemoteAuditProgress {
  completedObjects: number;
  totalObjects: number;
  missingClosure: string[];
}

export interface RemoteAuditOptions {
  onProgress?: (progress: RemoteAuditProgress) => void;
  signal?: AbortSignal;
  sliceSize?: number;
  yieldToIdle?: () => Promise<void>;
}

export class RemoteAuditFailure extends Error {
  readonly code: string;
  readonly kind: ObjectStoreFailureKind;
  readonly deletionEvidenceAllowed = false;

  constructor(
    readonly objectKey: string,
    readonly progress: RemoteAuditProgress,
    failure: unknown,
  ) {
    const kind = auditFailureKind(failure);
    super("Full audit could not verify a reachable repository object");
    this.name = "RemoteAuditFailure";
    this.kind = kind;
    this.code = kind === "auth" ? "audit-authentication"
      : kind === "throttled" ? "audit-rate-limit"
      : kind === "temporary" || kind === "cancelled" ? "audit-network"
      : "integrity-missing-closure";
  }
}

export class RemoteAuditCancelled extends Error {
  readonly code = "audit-cancelled";
  readonly kind = "cancelled" as const;
  readonly deletionEvidenceAllowed = false;

  constructor(
    readonly objectKey: string,
    readonly progress: RemoteAuditProgress,
  ) {
    super("Full audit was cancelled before the reachable closure was verified");
    this.name = "RemoteAuditCancelled";
  }
}

export function remoteAuditFailureProgress(error: unknown): RemoteAuditProgress | undefined {
  if (!(error instanceof RemoteAuditFailure || error instanceof RemoteAuditCancelled)) return undefined;
  return copyProgress(error.progress);
}

export async function pollRemoteCommitKeys(
  store: ObjectStore,
  prefix: string,
  repositoryId: string,
  marker: ReadonlySet<string> = new Set(),
  options: ObjectStoreRequestOptions = {},
): Promise<string[]> {
  const root = [prefix.replace(/\/$/, ""), `.obsidian-s3-sync/v1/repositories/${repositoryId}/commits/`].filter(Boolean).join("/");
  const keys = new Set<string>();
  const tokens = new Set<string>();
  let token: string | undefined;
  do {
    const page = await store.list(root, token, options);
    page.keys.filter((key) => key.startsWith(root) && /\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\/\d{20}-[0-9a-f]{64}\.json$/.test(key)).forEach((key) => keys.add(key));
    token = page.continuationToken;
    if (token && (tokens.has(token) || (tokens.add(token), false))) throw new Error("ObjectStore returned a repeated continuation token");
  } while (token);
  return [...keys].filter((key) => !marker.has(key)).sort();
}

export async function auditRemoteRepository(
  store: ObjectStore,
  prefix: string,
  repositoryId: string,
  descriptorHash: string,
  options: RemoteAuditOptions = {},
): Promise<RemoteAuditResult> {
  const sliceSize = options.sliceSize ?? 64;
  if (!Number.isSafeInteger(sliceSize) || sliceSize < 1) throw new Error("remote audit slice size is invalid");
  const discovered = new Set<string>();
  const completed = new Set<string>();
  const missing = new Set<string>();
  const reachableObjects = new Map<string, RepositoryObjectStat>();
  const versionObjectKeys = new Map<string, readonly string[]>();
  let logicalReferencedBlobBytes = 0;
  let workSinceYield = 0;
  const report = (): RemoteAuditProgress => {
    const progress = {
      completedObjects: completed.size,
      totalObjects: discovered.size,
      missingClosure: [...missing].sort(compareUtf8),
    };
    options.onProgress?.(copyProgress(progress));
    return progress;
  };
  const discover = (key: string): void => {
    if (discovered.has(key)) return;
    discovered.add(key);
    report();
  };
  const cooperate = async (key: string): Promise<void> => {
    if (options.signal?.aborted) throw new RemoteAuditCancelled(key, report());
    workSinceYield += 1;
    if (workSinceYield < sliceSize) return;
    workSinceYield = 0;
    await (options.yieldToIdle ?? defaultYieldToIdle)();
    if (options.signal?.aborted) throw new RemoteAuditCancelled(key, report());
  };
  const complete = async (key: string): Promise<void> => {
    missing.delete(key);
    completed.add(key);
    report();
    await cooperate(key);
  };
  const fail = (key: string, error: unknown): never => {
    discovered.add(key);
    completed.delete(key);
    const kind = auditFailureKind(error);
    if (kind === "not-found" || kind === "integrity") missing.add(key);
    throw new RemoteAuditFailure(key, report(), error);
  };
  const failOperation = (key: string, error: unknown): never => {
    if (options.signal?.aborted || auditFailureKind(error) === "cancelled") {
      throw new RemoteAuditCancelled(key, report());
    }
    throw new RemoteAuditFailure(key, report(), error);
  };
  const recordObject = (object: RepositoryObjectStat): void => {
    const existing = reachableObjects.get(object.key);
    if (existing && (existing.kind !== object.kind || existing.size !== object.size || existing.contentHash !== object.contentHash)) {
      fail(object.key, new Error("reachable object metadata changed during audit"));
    }
    reachableObjects.set(object.key, { ...object });
  };
  const recordVersionObjects = (versionId: string, keys: readonly string[]): void => {
    const normalized = [...new Set(keys)].sort(compareUtf8);
    const existing = versionObjectKeys.get(versionId);
    if (existing && (existing.length !== normalized.length || existing.some((key, index) => key !== normalized[index]))) {
      fail(versionId, new Error("one Version ID resolved to different object dependencies"));
    }
    versionObjectKeys.set(versionId, normalized);
  };
  const attempt = async <T>(key: string, operation: () => T | Promise<T>): Promise<T> => {
    if (options.signal?.aborted) throw new RemoteAuditCancelled(key, report());
    try { return await operation(); }
    catch (error) {
      if (options.signal?.aborted || auditFailureKind(error) === "cancelled") {
        throw new RemoteAuditCancelled(key, report());
      }
      return fail(key, error);
    }
  };

  const descriptorObjectKey = descriptorKey(prefix, repositoryId);
  discover(descriptorObjectKey);
  const descriptor = await attempt(descriptorObjectKey, async () => {
    const descriptorBytes = await readObjectBytes(store, descriptorObjectKey, { signal: options.signal, maximumBytes: 4 * 1024, expectedHash: descriptorHash });
    const verified = verifyRepositoryDescriptorAtKey(prefix, descriptorObjectKey, descriptorBytes);
    if (verified.descriptorHash !== descriptorHash) throw new Error("repository descriptor Hash changed");
    return verified;
  });
  await complete(descriptorObjectKey);
  const binding: ConfigTreeBinding = {
    configDir: descriptor.descriptor.configDir as string,
    historicalConfigDirs: [...descriptor.descriptor.historicalConfigDirs as string[]],
  };
  const repository = new InMemoryRepositoryCore();
  const commitListKey = `${descriptorObjectKey.slice(0, -"format.json".length)}commits/`;
  const commitKeys = await pollRemoteCommitKeys(store, prefix, repositoryId, new Set(), { signal: options.signal })
    .catch((error: unknown) => failOperation(commitListKey, error));
  for (const key of commitKeys) {
    discover(key);
    await cooperate(key);
  }
  const verifiedBlobs = new Map<string, number>();
  const verifiedTrees = new Map<string, Awaited<ReturnType<typeof downloadConfigTree>>>();
  const verifiedChunks = new Map<string, Uint8Array>();
  for (const commitObjectKey of commitKeys) {
    const commitHash = commitObjectKey.match(/-([0-9a-f]{64})\.json$/)?.[1];
    if (!commitHash) fail(commitObjectKey, new Error("invalid Commit key during audit"));
    const commitBytes = await attempt(commitObjectKey, () => readObjectBytes(store, commitObjectKey, { signal: options.signal, maximumBytes: 256 * 1024, expectedHash: commitHash }));
    recordObject({ key: commitObjectKey, kind: "commit", size: commitBytes.byteLength, contentHash: commitHash });
    const commit = await attempt(commitObjectKey, () => parseAndValidateProtocolObject("commit", commitBytes) as unknown as ProtocolCommit);
    const chunkKeys = commit.changeChunkHashes.map((hash) => changeChunkKey(prefix, repositoryId, hash));
    chunkKeys.forEach(discover);
    const chunkBytes: Uint8Array[] = [];
    for (let index = 0; index < chunkKeys.length; index += 1) {
      const key = chunkKeys[index];
      let bytes = verifiedChunks.get(key);
      if (!bytes) {
          bytes = await attempt(key, () => readObjectBytes(store, key, {
            signal: options.signal,
            maximumBytes: 4 * 1024 * 1024,
            expectedHash: commit.changeChunkHashes[index],
          }));
        verifiedChunks.set(key, bytes);
        recordObject({ key, kind: "change-chunk", size: bytes.byteLength, contentHash: commit.changeChunkHashes[index] });
      }
      chunkBytes.push(bytes);
      await cooperate(key);
    }
    const envelope = await attempt(commitObjectKey, () => parseAndValidateKeyedCommitEnvelope(
      repositoryId, descriptorHash, commitObjectKey, commitBytes, chunkKeys, chunkBytes,
    ));
    const configTrees = new Map<string, Awaited<ReturnType<typeof downloadConfigTree>>>();
    for (const chunk of envelope.chunks) {
      for (let mutationIndex = 0; mutationIndex < chunk.mutations.length; mutationIndex += 1) {
        const mutation = chunk.mutations[mutationIndex];
        const dependencies = [commitObjectKey, chunkKeys[chunk.chunkIndex]];
        if (commit.channel === "config" && mutation.treeHash && !configTrees.has(mutation.treeHash)) {
          const treeObjectKey = configTreeKey(prefix, repositoryId, mutation.treeHash);
          discover(treeObjectKey);
          let tree = verifiedTrees.get(mutation.treeHash);
          if (!tree) {
            tree = await attempt(treeObjectKey, () => downloadConfigTree(store, prefix, repositoryId, descriptorHash, mutation.treeHash!, binding, { signal: options.signal }));
            verifiedTrees.set(mutation.treeHash, tree);
            const treeBytes = new TextEncoder().encode(canonicalizeProtocolJson(tree));
            recordObject({ key: treeObjectKey, kind: "config-tree", size: treeBytes.byteLength, contentHash: mutation.treeHash });
            await complete(treeObjectKey);
          }
          configTrees.set(mutation.treeHash, tree);
          for (const item of tree.items) {
            if (item.kind !== "put" || !item.blobHash || item.size === undefined) continue;
            const objectKey = blobKey(prefix, repositoryId, item.blobHash);
            discover(objectKey);
            recordObject({ key: objectKey, kind: "blob", size: item.size, contentHash: item.blobHash });
            const knownSize = verifiedBlobs.get(item.blobHash);
            if (knownSize !== undefined) {
              if (knownSize !== item.size) fail(objectKey, new Error("same Blob Hash has inconsistent declared sizes"));
              continue;
            }
            await attempt(objectKey, () => verifyRemoteBlob(store, prefix, repositoryId, { hash: item.blobHash!, size: item.size! }, { signal: options.signal }));
            verifiedBlobs.set(item.blobHash, item.size);
            await complete(objectKey);
          }
        }
        if (commit.channel === "config" && mutation.treeHash) {
          const tree = configTrees.get(mutation.treeHash);
          if (!tree) fail(configTreeKey(prefix, repositoryId, mutation.treeHash), new Error("ConfigTree dependency was not retained for Version accounting"));
          dependencies.push(configTreeKey(prefix, repositoryId, mutation.treeHash));
          for (const item of tree!.items) {
            if (item.kind !== "put" || !item.blobHash || item.size === undefined) continue;
            dependencies.push(blobKey(prefix, repositoryId, item.blobHash));
            logicalReferencedBlobBytes += item.size;
          }
        }
        if (commit.channel === "vault" && mutation.kind === "put" && mutation.blobHash && mutation.size !== undefined) {
          const objectKey = blobKey(prefix, repositoryId, mutation.blobHash);
          discover(objectKey);
          recordObject({ key: objectKey, kind: "blob", size: mutation.size, contentHash: mutation.blobHash });
          const knownSize = verifiedBlobs.get(mutation.blobHash);
          if (knownSize !== undefined && knownSize !== mutation.size) {
            fail(objectKey, new Error("same Blob Hash has inconsistent declared sizes"));
          }
          if (knownSize === undefined) {
            await attempt(objectKey, () => verifyRemoteBlob(store, prefix, repositoryId, { hash: mutation.blobHash!, size: mutation.size! }, { signal: options.signal }));
            verifiedBlobs.set(mutation.blobHash, mutation.size);
            await complete(objectKey);
          }
          dependencies.push(objectKey);
          logicalReferencedBlobBytes += mutation.size;
        }
        recordVersionObjects(createVersionId(commitHash!, chunk.chunkIndex, mutationIndex), dependencies);
      }
    }
    await attempt(commitObjectKey, () => {
      receiveKeyedCommitBytes(repository, repositoryId, descriptorHash, commitObjectKey, commitBytes, chunkKeys, chunkBytes, configTrees, binding);
    });
    await complete(commitObjectKey);
    for (const key of chunkKeys) await complete(key);
  }
  const progress = report();
  return {
    repositoryId,
    descriptorHash,
    configDir: binding.configDir,
    historicalConfigDirs: [...binding.historicalConfigDirs],
    repository,
    commitKeys,
    verifiedObjects: progress.completedObjects,
    totalObjects: progress.totalObjects,
    missingClosure: progress.missingClosure,
    status: "complete",
    deletionEvidenceAllowed: true,
    reachableObjects: [...reachableObjects.values()].sort((left, right) => compareUtf8(left.key, right.key)),
    versionObjectKeys,
    logicalReferencedBlobBytes,
  };
}

async function defaultYieldToIdle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function auditFailureKind(error: unknown): ObjectStoreFailureKind {
  return error instanceof ObjectStoreError ? error.kind : "integrity";
}

function copyProgress(progress: RemoteAuditProgress): RemoteAuditProgress {
  return { ...progress, missingClosure: [...progress.missingClosure] };
}
