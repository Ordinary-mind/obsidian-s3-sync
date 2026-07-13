import type { ConfigTreeForLineage, ProtocolChunk, ProtocolCommit } from "../protocol/semantics";
import { createVersionId } from "./version-id";
import type { RegisterVersion } from "./register";
import { isVaultPathExcluded } from "./scope";

export interface VaultScopeBinding {
  configDir: string;
  historicalConfigDirs: readonly string[];
}

export function registerVersionsFromEnvelope(
  commitHash: string,
  commit: ProtocolCommit,
  chunks: readonly ProtocolChunk[],
  configTreesByHash: ReadonlyMap<string, ConfigTreeForLineage> = new Map(),
  vaultScope?: VaultScopeBinding,
): RegisterVersion[] {
  return chunks.flatMap((chunk, envelopeIndex) => chunk.mutations.flatMap((mutation, mutationIndex) => {
    if (commit.channel === "vault" && vaultScope && isVaultPathExcluded(mutation.path!, vaultScope.configDir, vaultScope.historicalConfigDirs)) {
      return [];
    }
    const configTree = commit.channel === "config" ? configTreesByHash.get(mutation.treeHash!) : undefined;
    return [{
    repositoryId: commit.repositoryId,
    channel: commit.channel,
    logicalKey: commit.channel === "config" ? "portable" : mutation.path!,
    versionId: createVersionId(commitHash, chunk.chunkIndex ?? envelopeIndex, mutationIndex),
    parents: [...mutation.parents],
    ...(configTree ? { configTree } : {}),
    ...(mutation.kind === "put" && mutation.blobHash && mutation.size !== undefined ? { blob: { hash: mutation.blobHash, size: mutation.size } } : {}),
    }];
  }));
}
