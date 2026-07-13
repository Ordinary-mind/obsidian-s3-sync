import { blobKey, changeChunkKey, descriptorKey } from "../protocol/keys";
import type { ConfigTreeForLineage, ProtocolCommit } from "../protocol/semantics";
import { parseAndValidateKeyedCommitEnvelope, parseAndValidateProtocolObject, verifyRepositoryDescriptorAtKey } from "../protocol/validation";
import { downloadConfigTree, type ConfigTreeBinding } from "./config-tree";
import { readObjectBytes, type ObjectStore } from "./object-store";
import { receiveKeyedCommitBytes } from "./receive-repository";
import { downloadVerifiedBlob } from "./remote-blob";
import { InMemoryRepositoryCore } from "./repository";

export interface RemoteAuditResult {
  repository: InMemoryRepositoryCore;
  commitKeys: string[];
  verifiedObjects: number;
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
): Promise<RemoteAuditResult> {
  const descriptorObjectKey = descriptorKey(prefix, repositoryId);
  const descriptorBytes = await readObjectBytes(store, descriptorObjectKey, { maximumBytes: 4 * 1024, expectedHash: descriptorHash });
  const descriptor = verifyRepositoryDescriptorAtKey(prefix, descriptorObjectKey, descriptorBytes);
  if (descriptor.descriptorHash !== descriptorHash) throw new Error("repository descriptor Hash changed");
  const binding: ConfigTreeBinding = {
    configDir: descriptor.descriptor.configDir as string,
    historicalConfigDirs: [...descriptor.descriptor.historicalConfigDirs as string[]],
  };
  const repository = new InMemoryRepositoryCore();
  const commitKeys = await pollRemoteCommitKeys(store, prefix, repositoryId);
  const verifiedBlobs = new Map<string, number>();
  const verifiedTrees = new Set<string>();
  let verifiedObjects = 1;
  for (const commitObjectKey of commitKeys) {
    const commitHash = commitObjectKey.match(/-([0-9a-f]{64})\.json$/)?.[1];
    if (!commitHash) throw new Error("invalid Commit key during audit");
    const commitBytes = await readObjectBytes(store, commitObjectKey, { maximumBytes: 256 * 1024, expectedHash: commitHash });
    const commit = parseAndValidateProtocolObject("commit", commitBytes) as unknown as ProtocolCommit;
    const chunkKeys = commit.changeChunkHashes.map((hash) => changeChunkKey(prefix, repositoryId, hash));
    const chunkBytes = await Promise.all(chunkKeys.map((key, index) => readObjectBytes(store, key, {
      maximumBytes: 4 * 1024 * 1024,
      expectedHash: commit.changeChunkHashes[index],
    })));
    const envelope = parseAndValidateKeyedCommitEnvelope(repositoryId, descriptorHash, commitObjectKey, commitBytes, chunkKeys, chunkBytes);
    const configTrees = new Map<string, ConfigTreeForLineage>();
    for (const chunk of envelope.chunks) {
      for (const mutation of chunk.mutations) {
        if (commit.channel === "config" && mutation.treeHash && !configTrees.has(mutation.treeHash)) {
          const tree = await downloadConfigTree(store, prefix, repositoryId, descriptorHash, mutation.treeHash, binding);
          configTrees.set(mutation.treeHash, tree);
          if (!verifiedTrees.has(mutation.treeHash)) {
            verifiedTrees.add(mutation.treeHash);
            verifiedObjects += 1;
          }
          for (const item of tree.items) {
            if (item.kind !== "put" || !item.blobHash || item.size === undefined) continue;
            const knownSize = verifiedBlobs.get(item.blobHash);
            if (knownSize !== undefined) {
              if (knownSize !== item.size) throw new Error("same Blob Hash has inconsistent declared sizes");
              continue;
            }
            await downloadVerifiedBlob(store, prefix, repositoryId, { hash: item.blobHash, size: item.size });
            verifiedBlobs.set(item.blobHash, item.size);
            verifiedObjects += 1;
          }
        }
        if (commit.channel === "vault" && mutation.kind === "put" && mutation.blobHash && mutation.size !== undefined) {
          const knownSize = verifiedBlobs.get(mutation.blobHash);
          if (knownSize !== undefined && knownSize !== mutation.size) {
            throw new Error("same Blob Hash has inconsistent declared sizes");
          }
          if (knownSize === undefined) {
            await downloadVerifiedBlob(store, prefix, repositoryId, { hash: mutation.blobHash, size: mutation.size });
            verifiedBlobs.set(mutation.blobHash, mutation.size);
            verifiedObjects += 1;
          }
        }
      }
    }
    receiveKeyedCommitBytes(repository, repositoryId, descriptorHash, commitObjectKey, commitBytes, chunkKeys, chunkBytes, configTrees, binding);
    verifiedObjects += 1 + chunkBytes.length;
  }
  return { repository, commitKeys, verifiedObjects };
}
