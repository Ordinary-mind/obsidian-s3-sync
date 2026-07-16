import type { SyncDiagnosticCategory } from "./diagnostics";
import type { OperationalStatus } from "./operational-status";

export type SyncPreflightBlocker =
  | "repository-state-recovery"
  | "apply-journal-recovery"
  | "config-journal-recovery"
  | "operational-recovery"
  | "repository-stopped";

export interface SyncPreflightEvidence {
  status: OperationalStatus;
}

export class SyncPreflightError extends Error {
  readonly kind = "sync-preflight";

  constructor(readonly blocker: SyncPreflightBlocker) {
    super("sync preflight blocked");
    this.name = "SyncPreflightError";
  }
}

export function syncPreflightBlocker(evidence: SyncPreflightEvidence): SyncPreflightBlocker | undefined {
  const { status } = evidence;
  if (status.phase === "stopped") return "repository-stopped";
  const manual = status.recoveryBlockers.find((blocker) => blocker.disposition === "manual");
  if (manual?.code === "repository-state") return "repository-state-recovery";
  if (manual?.code === "vault-apply") return "apply-journal-recovery";
  if (manual?.code === "config-apply") return "config-journal-recovery";
  if (manual) return "operational-recovery";
  // 仓库身份错误允许先做只读重验；只有实体恢复记录才能永久阻断。
  if (!status.repositoryIdentityValid) return undefined;
  if (status.phase === "read-only") return "operational-recovery";
  return undefined;
}

export function verifiedRepositoryOperationalStatus(status: OperationalStatus): OperationalStatus {
  const revalidatedIdentityLock = status.lastError?.category === "repository-identity" && !status.repositoryIdentityValid;
  if (!revalidatedIdentityLock) return status;
  return {
    ...status,
    phase: status.phase === "read-only" ? "idle" : status.phase,
    retryAt: undefined,
    retryAttempt: 0,
    lastError: undefined,
    repositoryIdentityValid: true,
  };
}

export function verifiedTerminalOutboxOperationalStatus(status: OperationalStatus): OperationalStatus {
  const terminalError = status.lastError?.syncStage === "outbox-replay";
  if (!terminalError) return status;
  return {
    ...status,
    phase: status.phase === "read-only" || status.phase === "recovering" ? "idle" : status.phase,
    retryAt: undefined,
    retryAttempt: 0,
    lastError: undefined,
    repositoryIdentityValid: true,
  };
}

export function syncPreflightCategory(blocker: SyncPreflightBlocker): SyncDiagnosticCategory {
  return "local-path";
}

export function isSyncPreflightBlocker(value: unknown): value is SyncPreflightBlocker {
  return typeof value === "string" && [
    "repository-state-recovery",
    "apply-journal-recovery",
    "config-journal-recovery",
    "operational-recovery",
    "repository-stopped",
  ].includes(value);
}
