import type { RepositoryHealth } from "./repository-health";
import type { SyncRoundPhase } from "./sync-round";

export interface SyncStatusSnapshot {
  phase: SyncRoundPhase;
  health: RepositoryHealth;
  pendingDependencies: number;
  pendingApply: number;
  outboxEntries: number;
  conflicts: number;
}

export function hasOutstandingSafetyWork(status: SyncStatusSnapshot): boolean {
  return status.health !== "healthy" || status.pendingDependencies > 0 || status.pendingApply > 0 || status.outboxEntries > 0 || status.conflicts > 0;
}
