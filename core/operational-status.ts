import type { CoordinatorPhase } from "./sync-coordinator";
import type { SyncDiagnosticCategory } from "./diagnostics";

export type PathDecisionKind = "same" | "local-put" | "remote-put" | "tombstone" | "conflict" | "ignored" | "unknown";

export interface PathDecisionRecord {
  path: string;
  decision: PathDecisionKind;
  reason: string;
}

export interface FullAuditStatus {
  state: "never" | "running" | "complete" | "cancelled" | "failed";
  completedObjects: number;
  totalObjects: number;
  missingClosure: string[];
  resumable: boolean;
  completedAt?: number;
}

export interface OperationalStatus {
  phase: CoordinatorPhase;
  lastSuccessfulPull?: number;
  lastSuccessfulPublish?: number;
  lastSuccessfulAudit?: number;
  pendingApply: number;
  outbox: number;
  localConcurrentRecords: number;
  recoveryFiles: number;
  postCaptureEdits: number;
  commitGaps: number;
  conflicts: number;
  retryAt?: number;
  retryAttempt: number;
  lastError?: { category: SyncDiagnosticCategory; message: string };
  decisions: PathDecisionRecord[];
  audit: FullAuditStatus;
  recoveryRequired: boolean;
  repositoryIdentityValid: boolean;
}

export function repositoryHealthLabel(status: OperationalStatus): "healthy" | "working" | "attention" | "diagnostics-only" {
  if (!status.repositoryIdentityValid || status.recoveryRequired) return "diagnostics-only";
  if (status.lastError || status.conflicts > 0 || status.commitGaps > 0 || status.audit.state === "failed") return "attention";
  if (status.phase !== "idle" || status.pendingApply > 0 || status.outbox > 0 || status.localConcurrentRecords > 0 || status.audit.state === "running") return "working";
  return "healthy";
}

export function mayClaimRepositoryFullyHealthy(status: OperationalStatus): boolean {
  return repositoryHealthLabel(status) === "healthy"
    && status.audit.state === "complete"
    && status.audit.completedObjects === status.audit.totalObjects
    && status.audit.missingClosure.length === 0;
}

export function retryCountdownSeconds(status: OperationalStatus, now: number): number | undefined {
  return status.retryAt === undefined ? undefined : Math.max(0, Math.ceil((status.retryAt - now) / 1000));
}

export interface HighRiskOperationSummary {
  repositoryId: string;
  normalizedPrefix: string;
  objectCount: number;
  totalBytes: number;
  recoveryLocation: string;
}

export function assertHighRiskSummaryComplete(summary: HighRiskOperationSummary): void {
  if (!summary.repositoryId || summary.normalizedPrefix === undefined || !Number.isSafeInteger(summary.objectCount) || summary.objectCount < 0
    || !Number.isSafeInteger(summary.totalBytes) || summary.totalBytes < 0 || !summary.recoveryLocation) {
    throw new Error("high-risk operation summary is incomplete");
  }
}

export function destructiveRepositoryResetAvailable(): false { return false; }
