import type { ConfigSnapshotMutation, VaultMutation } from "./types";

export function vaultSemanticValue(mutation: VaultMutation): string {
  return mutation.kind === "delete" ? "vault:delete" : `vault:blob:${mutation.blob?.hash ?? missingBlob()}`;
}

export function configSemanticValue(mutation: ConfigSnapshotMutation): string {
  return `config:tree:${mutation.treeHash}`;
}

function missingBlob(): never {
  throw new Error("Vault put requires a BlobRef");
}
