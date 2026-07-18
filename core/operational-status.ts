import type { SyncDiagnosticCategory } from "./diagnostics";
import type { RepositorySpaceStatistics } from "./repository-statistics";

export type CoordinatorPhase =
  | "idle"
  | "recovering"
  | "verifying-repository"
  | "pulling"
  | "merging"
  | "applying"
  | "scanning"
  | "repulling"
  | "freezing-outbox"
  | "publishing"
  | "verifying-publication"
  | "auditing"
  | "previewing"
  | "waiting-retry"
  | "read-only"
  | "stopped";

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
  space?: RepositorySpaceSummary;
}

export type RepositorySpaceSummary = Omit<RepositorySpaceStatistics, "orphanKeys">;

export type RecoveryBlockerCode =
  | "repository-state"
  | "durable-outbox"
  | "vault-apply"
  | "config-apply";

export interface RecoveryBlocker {
  code: RecoveryBlockerCode;
  source: "repository-state" | "outbox" | "vault-apply-journal" | "config-apply-journal";
  disposition: "automatic" | "manual";
  message: string;
}

export interface OperationalError {
  category: SyncDiagnosticCategory;
  message: string;
  report: string;
  syncStage?: string;
  connectionStage?: string;
}

export function summarizeRepositorySpace(space: RepositorySpaceStatistics): RepositorySpaceSummary {
  const { orphanKeys: _orphanKeys, ...summary } = space;
  return structuredClone(summary);
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
  lastError?: OperationalError;
  decisions: PathDecisionRecord[];
  audit: FullAuditStatus;
  recoveryBlockers: RecoveryBlocker[];
  repositoryIdentityValid: boolean;
}

export function repositoryHealthLabel(status: OperationalStatus): "healthy" | "working" | "attention" | "diagnostics-only" {
  if (!status.repositoryIdentityValid || hasManualRecoveryBlocker(status)) return "diagnostics-only";
  if (status.lastError || status.conflicts > 0 || status.commitGaps > 0
    || status.audit.state === "failed" || status.audit.state === "cancelled"
    || status.audit.missingClosure.length > 0) return "attention";
  if (status.phase !== "idle" || status.pendingApply > 0 || status.outbox > 0 || status.localConcurrentRecords > 0 || status.audit.state === "running") return "working";
  if (status.audit.state !== "complete" || status.audit.completedObjects !== status.audit.totalObjects) return "attention";
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

export function operationalPhaseLabel(phase: CoordinatorPhase): string {
  const labels: Record<CoordinatorPhase, string> = {
    idle: "待命",
    recovering: "恢复",
    "verifying-repository": "验证仓库",
    pulling: "拉取",
    merging: "归并",
    applying: "应用",
    scanning: "扫描",
    repulling: "复查远端",
    "freezing-outbox": "准备上传",
    publishing: "上传",
    "verifying-publication": "验证发布",
    auditing: "完整校验",
    previewing: "预览",
    "waiting-retry": "等待重试",
    "read-only": "只读",
    stopped: "已停止",
  };
  return labels[phase];
}

export function repositoryHealthDisplayLabel(status: OperationalStatus): string {
  const label = repositoryHealthLabel(status);
  if (label === "healthy") return "完整校验通过";
  if (label === "working") return "处理中";
  if (label === "diagnostics-only") return "仅诊断";
  if (status.audit.state === "never") return "待完整校验";
  if (status.audit.state === "cancelled") return "校验已中断";
  if (status.audit.state === "failed" || status.audit.missingClosure.length > 0) return "校验失败";
  return "需要处理";
}

export function pathDecisionLabel(decision: PathDecisionKind): string {
  const labels: Record<PathDecisionKind, string> = {
    same: "相同",
    "local-put": "本地上传",
    "remote-put": "远端写入",
    tombstone: "删除",
    conflict: "冲突",
    ignored: "忽略",
    unknown: "未知",
  };
  return labels[decision];
}

export function diagnosticCategoryLabel(category: SyncDiagnosticCategory): string {
  const labels: Record<SyncDiagnosticCategory, string> = {
    authentication: "认证",
    network: "网络",
    "rate-limit": "限流",
    integrity: "完整性",
    "repository-identity": "仓库身份",
    "local-path": "本地路径",
    conflict: "冲突",
    cancelled: "已取消",
    internal: "内部错误",
  };
  return labels[category];
}

export function auditCoveragePercent(audit: FullAuditStatus): number {
  if (audit.totalObjects === 0) return audit.state === "complete" ? 100 : 0;
  return Math.max(0, Math.min(100, Math.floor(audit.completedObjects * 100 / audit.totalObjects)));
}

export function mayRunMutatingSync(status: OperationalStatus): boolean {
  return status.repositoryIdentityValid
    && !hasManualRecoveryBlocker(status)
    && status.phase !== "read-only"
    && status.phase !== "stopped";
}

export function hasManualRecoveryBlocker(status: Pick<OperationalStatus, "recoveryBlockers">): boolean {
  return status.recoveryBlockers.some((blocker) => blocker.disposition === "manual");
}

export function operationalStatusBarText(status: OperationalStatus): string {
  const details: string[] = [operationalPhaseLabel(status.phase), repositoryHealthDisplayLabel(status)];
  if (status.conflicts > 0) details.push(`冲突 ${status.conflicts}`);
  if (status.outbox > 0) details.push(`Outbox ${status.outbox}`);
  if (status.phase === "waiting-retry" && status.retryAttempt > 0) details.push(`重试 ${status.retryAttempt}`);
  return `S3 Sync：${details.join(" · ")}`;
}

export type PreviewLocalState = "absent" | "present" | "unknown";
export type PreviewLocalIntent = "none" | "put" | "delete";
export type PreviewRemoteState =
  | { kind: "none" }
  | { kind: "put"; hash: string }
  | { kind: "delete" }
  | { kind: "conflict"; reason?: string }
  | { kind: "unknown"; reason?: string };

export function derivePathDecision(input: {
  path: string;
  ignored: boolean;
  localState: PreviewLocalState;
  localHash?: string;
  localIntent: PreviewLocalIntent;
  projectedHash?: string;
  remote: PreviewRemoteState;
}): PathDecisionRecord {
  if (input.ignored) return { path: input.path, decision: "ignored", reason: "路径在冻结排除范围或用户忽略规则内" };
  if (input.remote.kind === "conflict") return { path: input.path, decision: "conflict", reason: input.remote.reason ?? "远端寄存器包含并发头" };
  if (input.localState === "unknown" || input.remote.kind === "unknown") {
    return { path: input.path, decision: "unknown", reason: input.remote.kind === "unknown" && input.remote.reason
      ? input.remote.reason
      : "本地或远端状态无法完整确认" };
  }
  if (input.remote.kind === "delete") {
    if (input.localIntent === "put") return { path: input.path, decision: "conflict", reason: "本地修改与远端删除同时发生" };
    return { path: input.path, decision: "tombstone", reason: "远端版本已删除；应用前会保留本地恢复副本" };
  }
  if (input.remote.kind === "put") {
    if (input.localState === "present" && input.localHash === input.remote.hash) {
      return { path: input.path, decision: "same", reason: "本地与远端字节 Hash 相同" };
    }
    if (input.localIntent === "put") {
      return input.projectedHash !== undefined && input.remote.hash === input.projectedHash
        ? { path: input.path, decision: "local-put", reason: "仅本地内容偏离共同基线；等待发布" }
        : { path: input.path, decision: "conflict", reason: "本地与远端内容均偏离共同基线" };
    }
    if (input.localIntent === "delete") {
      return input.projectedHash !== undefined && input.remote.hash === input.projectedHash
        ? { path: input.path, decision: "tombstone", reason: "仅本地删除偏离共同基线；等待发布" }
        : { path: input.path, decision: "conflict", reason: "本地删除与远端内容变化并发" };
    }
    return { path: input.path, decision: "remote-put", reason: input.localState === "absent"
      ? "本地缺失；仅计划安全创建"
      : "远端值不同；写入前需要前像与 no-clobber 守卫" };
  }
  if (input.localIntent === "put") {
    return input.localState === "present"
      ? { path: input.path, decision: "local-put", reason: "本地写入意图等待稳定捕获与发布" }
      : { path: input.path, decision: "unknown", reason: "本地写入意图尚无可验证的稳定磁盘字节" };
  }
  if (input.localIntent === "delete") return { path: input.path, decision: "tombstone", reason: "本地删除意图等待删除证据与发布" };
  if (input.localState === "present") return { path: input.path, decision: "local-put", reason: "本地内容尚无远端解析值" };
  return { path: input.path, decision: "same", reason: "本地与远端均无活动值" };
}

export function destructiveRepositoryResetAvailable(): false { return false; }
