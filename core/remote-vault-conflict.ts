import type { InMemoryRepositoryCore } from "./repository";
import type { RegisterDisposition } from "./conflict-state";
import { compareUtf8 } from "../protocol/utf8";

export type RemoteVaultConflictCandidate =
  | { kind: "put"; versionId: string; hash: string; size: number }
  | { kind: "delete"; versionId: string };

export interface RemoteVaultRegisterSnapshot {
  path: string;
  disposition: RegisterDisposition;
  heads: string[];
  candidates: RemoteVaultConflictCandidate[];
}

export function inspectRemoteVaultRegister(
  repository: InMemoryRepositoryCore,
  repositoryId: string,
  path: string,
): RemoteVaultRegisterSnapshot {
  const state = repository.register(repositoryId, "vault", path);
  return {
    path,
    disposition: state.disposition,
    heads: [...state.heads],
    candidates: state.heads.map((head) => candidateForHead(repository, repositoryId, path, head)),
  };
}

export function listRemoteVaultConflicts(
  repository: InMemoryRepositoryCore,
  repositoryId: string,
): RemoteVaultRegisterSnapshot[] {
  const conflicts: RemoteVaultRegisterSnapshot[] = [];
  for (const [key, state] of repository.allRegisters(repositoryId)) {
    if (!key.startsWith("vault:") || state.disposition !== "concurrent") continue;
    conflicts.push(inspectRemoteVaultRegister(repository, repositoryId, key.slice("vault:".length)));
  }
  return conflicts.sort((left, right) => compareUtf8(left.path, right.path));
}

function candidateForHead(
  repository: InMemoryRepositoryCore,
  repositoryId: string,
  path: string,
  versionId: string,
): RemoteVaultConflictCandidate {
  const version = repository.version(versionId);
  if (!version || version.repositoryId !== repositoryId || version.channel !== "vault" || version.logicalKey !== path) {
    throw new Error("remote Vault conflict head is unavailable");
  }
  return version.blob
    ? { kind: "put", versionId, hash: version.blob.hash, size: version.blob.size }
    : { kind: "delete", versionId };
}
