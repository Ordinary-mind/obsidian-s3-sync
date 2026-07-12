import { parseAndValidateProtocolObject } from "../protocol/validation";
import { changeChunkKey } from "../protocol/keys";
import type { ProtocolCommit } from "../protocol/semantics";
import type { ObjectStore } from "./object-store";
import { receiveKeyedCommitBytes } from "./receive-repository";
import { InMemoryRepositoryCore } from "./repository";

export async function pullCommitIntoRepository(store: ObjectStore, repository: InMemoryRepositoryCore, prefix: string, repositoryId: string, descriptorHash: string, commitKey: string): Promise<string[]> {
  const commitBytes = await store.get(commitKey);
  const commit = parseAndValidateProtocolObject("commit", commitBytes) as unknown as ProtocolCommit;
  const chunkKeys = commit.changeChunkHashes.map((hash) => changeChunkKey(prefix, repositoryId, hash));
  const chunkBytes = await Promise.all(chunkKeys.map((key) => store.get(key)));
  return receiveKeyedCommitBytes(repository, repositoryId, descriptorHash, commitKey, commitBytes, chunkKeys, chunkBytes);
}
