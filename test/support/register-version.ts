import type { RegisterVersion } from "../../core/register";
import type { ConfigSnapshotMutation, VaultMutation } from "../../core/types";
import type { ConfigTreeForLineage } from "../../protocol/semantics";

export function vaultRegisterVersion(
  repositoryId: string,
  versionId: string,
  mutation: VaultMutation,
): RegisterVersion {
  return {
    repositoryId,
    channel: "vault",
    logicalKey: mutation.path,
    versionId,
    parents: [...mutation.parents],
  };
}

export function configRegisterVersion(
  repositoryId: string,
  versionId: string,
  mutation: ConfigSnapshotMutation,
  configTree: ConfigTreeForLineage,
): RegisterVersion {
  return {
    repositoryId,
    channel: "config",
    logicalKey: mutation.key,
    versionId,
    parents: [...mutation.parents],
    configTree,
  };
}
