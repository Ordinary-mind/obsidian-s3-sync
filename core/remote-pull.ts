import { IncrementalCommitEnvelopeValidator, parseAndValidateProtocolObject } from "../protocol/validation";
import { changeChunkKey } from "../protocol/keys";
import type { ConfigTreeForLineage, ProtocolCommit } from "../protocol/semantics";
import { downloadConfigTree, type ConfigTreeBinding } from "./config-tree";
import { readObjectBytes, type ObjectStore } from "./object-store";
import { InMemoryRepositoryCore } from "./repository";
import { sha256Hex } from "../protocol/hash";
import type { CommitFrontierAnchor } from "./commit-frontier";
import { createDiskChunkStagingArea, type ChunkStagingArea } from "./chunk-staging";
import { registerVersionsFromEnvelope } from "./ingest";
import { BoundedExecutor } from "./bounded-executor";

export async function pullCommitIntoRepository(store: ObjectStore, repository: InMemoryRepositoryCore, prefix: string, repositoryId: string, descriptorHash: string, commitKey: string, configTreeBinding?: ConfigTreeBinding, createStaging: () => Promise<ChunkStagingArea> = createDiskChunkStagingArea): Promise<string[]> {
  return (await pullCommitWithAnchor(store, repository, prefix, repositoryId, descriptorHash, commitKey, configTreeBinding, createStaging)).versionIds;
}

async function pullCommitWithAnchor(store: ObjectStore, repository: InMemoryRepositoryCore, prefix: string, repositoryId: string, descriptorHash: string, commitKey: string, configTreeBinding?: ConfigTreeBinding, createStaging: () => Promise<ChunkStagingArea> = createDiskChunkStagingArea): Promise<{ versionIds: string[]; anchor: CommitFrontierAnchor }> {
  const commitBytes = await readObjectBytes(store, commitKey, { maximumBytes: 256 * 1024 });
  const commit = parseAndValidateProtocolObject("commit", commitBytes) as unknown as ProtocolCommit;
  const chunkKeys = commit.changeChunkHashes.map((hash) => changeChunkKey(prefix, repositoryId, hash));
  const commitHash = sha256Hex(commitBytes);
  const validator = new IncrementalCommitEnvelopeValidator(repositoryId, descriptorHash, commit, commitKey, commitHash);
  const staging = await createStaging();
  try {
    const configTreeHashes = new Set<string>();
    for (let index = 0; index < chunkKeys.length; index += 1) {
      const bytes = await readObjectBytes(store, chunkKeys[index], { maximumBytes: 4 * 1024 * 1024, expectedHash: commit.changeChunkHashes[index] });
      const chunk = await validator.acceptChunkIncrementally(index, chunkKeys[index], bytes, yieldToIdle);
      if (commit.channel === "config") {
        for (const mutation of chunk.mutations) configTreeHashes.add(mutation.treeHash!);
      }
      await staging.write(index, bytes);
    }
    validator.finish();
    const configTreesByHash = new Map<string, ConfigTreeForLineage>();
    for (const hash of configTreeHashes) {
      if (!configTreeBinding) throw new Error("ConfigTree descriptor binding is required");
      configTreesByHash.set(hash, await downloadConfigTree(store, prefix, repositoryId, descriptorHash, hash, configTreeBinding));
    }
    const versions = [];
    for (let index = 0; index < chunkKeys.length; index += 1) {
      const bytes = await staging.read(index);
      if (sha256Hex(bytes) !== commit.changeChunkHashes[index]) throw new Error("staged Change Chunk Hash changed");
      const chunk = parseAndValidateProtocolObject("change-chunk", bytes) as unknown as import("../protocol/semantics").ProtocolChunk;
      versions.push(...registerVersionsFromEnvelope(commitHash, commit, [chunk], configTreesByHash, configTreeBinding));
    }
    for (const version of versions) repository.ingest(version);
    return {
      versionIds: versions.map((version) => version.versionId),
      anchor: { key: commitKey, writerId: commit.writerId, sequence: commit.sequence, hash: commitHash, previousCommitHash: commit.previousCommitHash },
    };
  } finally {
    await staging.dispose();
  }
}

async function yieldToIdle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export async function pullCommitSetIntoRepository(
  store: ObjectStore,
  prefix: string,
  repositoryId: string,
  descriptorHash: string,
  commitKeys: readonly string[],
  configTreeBinding: ConfigTreeBinding,
  options: { concurrency?: number } = {},
): Promise<{ repository: InMemoryRepositoryCore; blockedCommitKeys: Array<{ key: string; reason: unknown }>; acceptedCommits: CommitFrontierAnchor[] }> {
  const repository = new InMemoryRepositoryCore();
  const blockedCommitKeys: Array<{ key: string; reason: unknown }> = [];
  const acceptedCommits: CommitFrontierAnchor[] = [];
  const concurrency = options.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("Commit pull concurrency is invalid");
  const keys = [...new Set(commitKeys)].sort();
  const executor = new BoundedExecutor(concurrency);
  const results = await Promise.all(keys.map((key) => executor.run(async () => {
    const isolated = new InMemoryRepositoryCore();
    try {
      const pulled = await pullCommitWithAnchor(store, isolated, prefix, repositoryId, descriptorHash, key, configTreeBinding);
      return { key, pulled, versions: isolated.snapshotVersions() } as const;
    } catch (reason) {
      return { key, reason } as const;
    }
  })));
  for (const result of results) {
    if ("reason" in result) {
      blockedCommitKeys.push({ key: result.key, reason: result.reason });
      continue;
    }
    for (const version of result.versions) repository.ingest(version);
    acceptedCommits.push(result.pulled.anchor);
  }
  return { repository, blockedCommitKeys, acceptedCommits };
}
