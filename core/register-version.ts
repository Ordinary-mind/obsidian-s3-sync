import type { Channel, ConfigSnapshotMutation, VaultMutation } from "./types";
import type { RegisterVersion } from "./register";
import type { ConfigTreeForLineage } from "../protocol/semantics";

export function vaultRegisterVersion(repositoryId: string, versionId: string, mutation: VaultMutation): RegisterVersion {
  return registerVersion(repositoryId, "vault", mutation.path, versionId, mutation.parents);
}

export function configRegisterVersion(
  repositoryId: string,
  versionId: string,
  mutation: ConfigSnapshotMutation,
  configTree: ConfigTreeForLineage,
): RegisterVersion {
  return { ...registerVersion(repositoryId, "config", mutation.key, versionId, mutation.parents), configTree };
}

function registerVersion(repositoryId: string, channel: Channel, logicalKey: string, versionId: string, parents: string[]): RegisterVersion {
  return { repositoryId, channel, logicalKey, versionId, parents: [...parents] };
}
