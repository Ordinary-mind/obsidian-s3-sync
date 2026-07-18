import type { RemoteVaultConflictCandidate } from "../core/remote-vault-conflict";

export interface RemoteCandidateGroup {
  candidate: RemoteVaultConflictCandidate;
  count: number;
}

export function groupRemoteConflictCandidates(
  candidates: readonly RemoteVaultConflictCandidate[],
): RemoteCandidateGroup[] {
  const groups = new Map<string, RemoteCandidateGroup>();
  for (const candidate of candidates) {
    const key = candidate.kind === "delete" ? "delete" : `put:${candidate.hash}:${candidate.size}`;
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, { candidate: { ...candidate }, count: 1 });
  }
  return [...groups.values()];
}
