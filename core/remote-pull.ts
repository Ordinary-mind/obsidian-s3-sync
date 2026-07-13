import { parseAndValidateProtocolObject } from "../protocol/validation";
import { changeChunkKey } from "../protocol/keys";
import type { ConfigTreeForLineage, ProtocolCommit } from "../protocol/semantics";
import { downloadConfigTree, type ConfigTreeBinding } from "./config-tree";
import { readObjectBytes, type ObjectStore } from "./object-store";
import { receiveKeyedCommitBytes } from "./receive-repository";
import { InMemoryRepositoryCore } from "./repository";

export async function pullCommitIntoRepository(store: ObjectStore, repository: InMemoryRepositoryCore, prefix: string, repositoryId: string, descriptorHash: string, commitKey: string, configTreeBinding?: ConfigTreeBinding): Promise<string[]> {
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
    if (!configTreeBinding) throw new Error("ConfigTree descriptor binding is required");
    const tree = await downloadConfigTree(store, prefix, repositoryId, descriptorHash, hash, configTreeBinding);
    configTreesByHash.set(hash, tree);
  }));
  return receiveKeyedCommitBytes(repository, repositoryId, descriptorHash, commitKey, commitBytes, chunkKeys, chunkBytes, configTreesByHash, configTreeBinding);
}
