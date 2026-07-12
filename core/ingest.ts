import type { ProtocolChunk, ProtocolCommit } from "../protocol/semantics";
import { createVersionId } from "./version-id";
import type { RegisterVersion } from "./register";

export function registerVersionsFromEnvelope(commitHash: string, commit: ProtocolCommit, chunks: readonly ProtocolChunk[]): RegisterVersion[] {
  return chunks.flatMap((chunk, chunkIndex) => chunk.mutations.map((mutation, mutationIndex) => ({
    repositoryId: commit.repositoryId,
    channel: commit.channel,
    logicalKey: commit.channel === "config" ? "portable" : mutation.path!,
    versionId: createVersionId(commitHash, chunkIndex, mutationIndex),
    parents: [...mutation.parents],
  })));
}
