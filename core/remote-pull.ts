import { parseAndValidateBoundObject, parseAndValidateProtocolObject } from "../protocol/validation";
import { changeChunkKey, configTreeKey } from "../protocol/keys";
import { assertObjectBodyHash } from "../protocol/hash";
import type { ConfigTreeForLineage, ProtocolCommit } from "../protocol/semantics";
import { readObjectBytes, type ObjectStore } from "./object-store";
import { receiveKeyedCommitBytes } from "./receive-repository";
import { InMemoryRepositoryCore } from "./repository";

export async function pullCommitIntoRepository(store: ObjectStore, repository: InMemoryRepositoryCore, prefix: string, repositoryId: string, descriptorHash: string, commitKey: string): Promise<string[]> {
  const commitBytes = await readObjectBytes(store, commitKey, { maximumBytes: 256 * 1024 });
  const commit = parseAndValidateProtocolObject("commit", commitBytes) as unknown as ProtocolCommit;
  const chunkKeys = commit.changeChunkHashes.map((hash) => changeChunkKey(prefix, repositoryId, hash));
  const chunkBytes = await Promise.all(chunkKeys.map((key) => readObjectBytes(store, key, { maximumBytes: 4 * 1024 * 1024 })));
  const configTreeHashes = commit.channel === "config"
    ? [...new Set(chunkBytes.flatMap((bytes) => {
      const chunk = parseAndValidateProtocolObject("change-chunk", bytes) as { mutations: Array<{ treeHash: string }> };
      return chunk.mutations.map((mutation) => mutation.treeHash);
    }))]
    : [];
  const configTreesByHash = new Map<string, ConfigTreeForLineage>();
  await Promise.all(configTreeHashes.map(async (hash) => {
    const treeBytes = await readObjectBytes(store, configTreeKey(prefix, repositoryId, hash), { maximumBytes: 16 * 1024 * 1024, expectedHash: hash });
    const tree = parseAndValidateBoundObject("config-tree", treeBytes, repositoryId, descriptorHash) as unknown as ConfigTreeForLineage;
    configTreesByHash.set(hash, tree);
  }));
  return receiveKeyedCommitBytes(repository, repositoryId, descriptorHash, commitKey, commitBytes, chunkKeys, chunkBytes, configTreesByHash);
}
