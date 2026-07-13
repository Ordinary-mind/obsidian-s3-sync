import type { ConfigTreeForLineage, ProtocolChunk, ProtocolCommit } from "../protocol/semantics";
import { createVersionId } from "./version-id";
import type { RegisterVersion } from "./register";

export function registerVersionsFromEnvelope(
  commitHash: string,
  commit: ProtocolCommit,
  chunks: readonly ProtocolChunk[],
  configTreesByHash: ReadonlyMap<string, ConfigTreeForLineage> = new Map(),
): RegisterVersion[] {
  return chunks.flatMap((chunk, chunkIndex) => chunk.mutations.map((mutation, mutationIndex) => {
    const configTree = commit.channel === "config" ? configTreesByHash.get(mutation.treeHash!) : undefined;
    return {
    repositoryId: commit.repositoryId,
    channel: commit.channel,
    logicalKey: commit.channel === "config" ? "portable" : mutation.path!,
    versionId: createVersionId(commitHash, chunkIndex, mutationIndex),
    parents: [...mutation.parents],
    ...(configTree ? { configTree } : {}),
  };
  }));
}
