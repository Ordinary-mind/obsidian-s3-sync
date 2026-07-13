import type { RecoveryRecord } from "./recovery-record";

export interface StagingReachability {
  dirtyRecords: readonly string[];
  localConcurrentRecords: readonly string[];
  outbox: readonly string[];
  publishedReconciles: readonly string[];
  conflictDrafts: readonly string[];
  journals: readonly string[];
  recoveryRecords: readonly RecoveryRecord[];
}

export interface StagingCleanupPlan {
  retained: string[];
  removable: string[];
}

export function planStagingCleanup(candidates: readonly string[], reachability: StagingReachability): StagingCleanupPlan {
  const reachable = new Set([
    ...reachability.dirtyRecords,
    ...reachability.localConcurrentRecords,
    ...reachability.outbox,
    ...reachability.publishedReconciles,
    ...reachability.conflictDrafts,
    ...reachability.journals,
  ]);
  // v1 恢复文件不参与自动清理，即使记录已解除其他引用也仍保留。
  for (const recovery of reachability.recoveryRecords) reachable.add(recovery.contentRef);
  const unique = [...new Set(candidates)].sort();
  return {
    retained: unique.filter((ref) => reachable.has(ref)),
    removable: unique.filter((ref) => !reachable.has(ref)),
  };
}

export function assertStagingReferenceBelowStateRoot(stateRoot: string, contentRef: string): void {
  const normalizedRoot = normalizeRelative(stateRoot);
  const normalizedRef = normalizeRelative(contentRef);
  if (normalizedRef !== normalizedRoot && !normalizedRef.startsWith(`${normalizedRoot}/`)) {
    throw new Error("staging reference escapes repository state root");
  }
}

function normalizeRelative(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (normalized.length === 0 || normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("state path is invalid");
  }
  return normalized;
}
