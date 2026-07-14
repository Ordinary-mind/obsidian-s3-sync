import { blobKey, changeChunkKey, configTreeKey, descriptorKey } from "../protocol/keys";
import type { ConfigTreeForLineage, ProtocolCommit } from "../protocol/semantics";
import { parseAndValidateKeyedCommitEnvelope, parseAndValidateProtocolObject, verifyRepositoryDescriptorAtKey } from "../protocol/validation";
import { downloadConfigTree, type ConfigTreeBinding } from "./config-tree";
import { ObjectStoreError, readObjectBytes, type ObjectStore, type ObjectStoreFailureKind } from "./object-store";
import { receiveKeyedCommitBytes } from "./receive-repository";
import { downloadVerifiedBlob } from "./remote-blob";
import { InMemoryRepositoryCore } from "./repository";

export interface RemoteAuditResult {
  repository: InMemoryRepositoryCore;
  commitKeys: string[];
  verifiedObjects: number;
  totalObjects: number;
  missingClosure: string[];
}

export interface RemoteAuditProgress {
  completedObjects: number;
  totalObjects: number;
  missingClosure: string[];
}

export interface RemoteAuditOptions {
  onProgress?: (progress: RemoteAuditProgress) => void;
}

export class RemoteAuditFailure extends Error {
  readonly code: string;
  readonly kind: ObjectStoreFailureKind;

  constructor(
    readonly objectKey: string,
    readonly progress: RemoteAuditProgress,
    cause: unknown,
  ) {
    const kind = auditFailureKind(cause);
    super("Full audit could not verify a reachable repository object", { cause });
    this.name = "RemoteAuditFailure";
    this.kind = kind;
    this.code = kind === "auth" ? "audit-authentication"
      : kind === "throttled" ? "audit-rate-limit"
      : kind === "temporary" || kind === "cancelled" ? "audit-network"
      : "integrity-missing-closure";
  }
}

export function remoteAuditFailureProgress(error: unknown): RemoteAuditProgress | undefined {
  if (!(error instanceof RemoteAuditFailure)) return undefined;
  return copyProgress(error.progress);
}

export async function pollRemoteCommitKeys(
  store: ObjectStore,
  prefix: string,
  repositoryId: string,
  marker: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const root = [prefix.replace(/\/$/, ""), `.obsidian-s3-sync/v1/repositories/${repositoryId}/commits/`].filter(Boolean).join("/");
  const keys = new Set<string>();
  const tokens = new Set<string>();
  let token: string | undefined;
  do {
    const page = await store.list(root, token);
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
  const discovered = new Set<string>();
  const completed = new Set<string>();
  const missing = new Set<string>();
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
  const complete = (key: string): void => {
    missing.delete(key);
    completed.add(key);
    report();
  };
  const fail = (key: string, error: unknown): never => {
    discovered.add(key);
    completed.delete(key);
    const kind = auditFailureKind(error);
    if (kind === "not-found" || kind === "integrity") missing.add(key);
    throw new RemoteAuditFailure(key, report(), error);
  };
  const failOperation = (key: string, error: unknown): never => {
    throw new RemoteAuditFailure(key, report(), error);
  };
  const attempt = async <T>(key: string, operation: () => T | Promise<T>): Promise<T> => {
    try { return await operation(); }
    catch (error) { return fail(key, error); }
  };

  const descriptorObjectKey = descriptorKey(prefix, repositoryId);
  discover(descriptorObjectKey);
  const descriptor = await attempt(descriptorObjectKey, async () => {
    const descriptorBytes = await readObjectBytes(store, descriptorObjectKey, { maximumBytes: 4 * 1024, expectedHash: descriptorHash });
    const verified = verifyRepositoryDescriptorAtKey(prefix, descriptorObjectKey, descriptorBytes);
    if (verified.descriptorHash !== descriptorHash) throw new Error("repository descriptor Hash changed");
    return verified;
  });
  complete(descriptorObjectKey);
  const binding: ConfigTreeBinding = {
    configDir: descriptor.descriptor.configDir as string,
    historicalConfigDirs: [...descriptor.descriptor.historicalConfigDirs as string[]],
  };
  const repository = new InMemoryRepositoryCore();
  const commitListKey = `${descriptorObjectKey.slice(0, -"format.json".length)}commits/`;
  const commitKeys = await pollRemoteCommitKeys(store, prefix, repositoryId)
    .catch((error: unknown) => failOperation(commitListKey, error));
  commitKeys.forEach(discover);
  const verifiedBlobs = new Map<string, number>();
  const verifiedTrees = new Map<string, Awaited<ReturnType<typeof downloadConfigTree>>>();
  const verifiedChunks = new Map<string, Uint8Array>();
  for (const commitObjectKey of commitKeys) {
    const commitHash = commitObjectKey.match(/-([0-9a-f]{64})\.json$/)?.[1];
    if (!commitHash) fail(commitObjectKey, new Error("invalid Commit key during audit"));
    const commitBytes = await attempt(commitObjectKey, () => readObjectBytes(store, commitObjectKey, { maximumBytes: 256 * 1024, expectedHash: commitHash }));
    const commit = await attempt(commitObjectKey, () => parseAndValidateProtocolObject("commit", commitBytes) as unknown as ProtocolCommit);
    const chunkKeys = commit.changeChunkHashes.map((hash) => changeChunkKey(prefix, repositoryId, hash));
    chunkKeys.forEach(discover);
    const chunkBytes: Uint8Array[] = [];
    for (let index = 0; index < chunkKeys.length; index += 1) {
      const key = chunkKeys[index];
      let bytes = verifiedChunks.get(key);
      if (!bytes) {
        bytes = await attempt(key, () => readObjectBytes(store, key, {
            maximumBytes: 4 * 1024 * 1024,
            expectedHash: commit.changeChunkHashes[index],
          }));
        verifiedChunks.set(key, bytes);
      }
      chunkBytes.push(bytes);
    }
    const envelope = await attempt(commitObjectKey, () => parseAndValidateKeyedCommitEnvelope(
      repositoryId, descriptorHash, commitObjectKey, commitBytes, chunkKeys, chunkBytes,
    ));
    const configTrees = new Map<string, ConfigTreeForLineage>();
    for (const chunk of envelope.chunks) {
      for (const mutation of chunk.mutations) {
        if (commit.channel === "config" && mutation.treeHash && !configTrees.has(mutation.treeHash)) {
          const treeObjectKey = configTreeKey(prefix, repositoryId, mutation.treeHash);
          discover(treeObjectKey);
          let tree = verifiedTrees.get(mutation.treeHash);
          if (!tree) {
            tree = await attempt(treeObjectKey, () => downloadConfigTree(store, prefix, repositoryId, descriptorHash, mutation.treeHash!, binding));
            verifiedTrees.set(mutation.treeHash, tree);
            complete(treeObjectKey);
          }
          configTrees.set(mutation.treeHash, tree);
          for (const item of tree.items) {
            if (item.kind !== "put" || !item.blobHash || item.size === undefined) continue;
            const objectKey = blobKey(prefix, repositoryId, item.blobHash);
            discover(objectKey);
            const knownSize = verifiedBlobs.get(item.blobHash);
            if (knownSize !== undefined) {
              if (knownSize !== item.size) fail(objectKey, new Error("same Blob Hash has inconsistent declared sizes"));
              continue;
            }
            await attempt(objectKey, () => downloadVerifiedBlob(store, prefix, repositoryId, { hash: item.blobHash!, size: item.size! }));
            verifiedBlobs.set(item.blobHash, item.size);
            complete(objectKey);
          }
        }
        if (commit.channel === "vault" && mutation.kind === "put" && mutation.blobHash && mutation.size !== undefined) {
          const objectKey = blobKey(prefix, repositoryId, mutation.blobHash);
          discover(objectKey);
          const knownSize = verifiedBlobs.get(mutation.blobHash);
          if (knownSize !== undefined && knownSize !== mutation.size) {
            fail(objectKey, new Error("same Blob Hash has inconsistent declared sizes"));
          }
          if (knownSize === undefined) {
            await attempt(objectKey, () => downloadVerifiedBlob(store, prefix, repositoryId, { hash: mutation.blobHash!, size: mutation.size! }));
            verifiedBlobs.set(mutation.blobHash, mutation.size);
            complete(objectKey);
          }
        }
      }
    }
    await attempt(commitObjectKey, () => {
      receiveKeyedCommitBytes(repository, repositoryId, descriptorHash, commitObjectKey, commitBytes, chunkKeys, chunkBytes, configTrees, binding);
    });
    complete(commitObjectKey);
    chunkKeys.forEach(complete);
  }
  const progress = report();
  return {
    repository,
    commitKeys,
    verifiedObjects: progress.completedObjects,
    totalObjects: progress.totalObjects,
    missingClosure: progress.missingClosure,
  };
}

function auditFailureKind(error: unknown): ObjectStoreFailureKind {
  return error instanceof ObjectStoreError ? error.kind : "integrity";
}

function copyProgress(progress: RemoteAuditProgress): RemoteAuditProgress {
  return { ...progress, missingClosure: [...progress.missingClosure] };
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}
