import { diagnosticCategory, type SyncDiagnosticCategory } from "./diagnostics";
import type { RepositoryConfigurationField, RepositoryConfigurationIssue } from "./locator";
import type { DurableOutboxReplayStage } from "./durable-outbox";
import {
  isSyncPreflightBlocker,
  syncPreflightCategory,
  type SyncPreflightBlocker,
} from "./sync-preflight";

export interface SafeErrorRecord {
  category: SyncDiagnosticCategory;
  reasonCode?: string;
  connectionStage?: ConnectionFlowStage;
  initializationStep?: ConnectionInitializationStep;
  persistenceStep?: LocalPersistenceStep;
  syncAction?: SyncAction;
  syncStage?: SyncFlowStage;
  preflightBlocker?: SyncPreflightBlocker;
  outboxStage?: DurableOutboxReplayStage;
  operation?: string;
  stage?: string;
  status?: number;
  requestId?: string;
  retries?: number;
  configurationField?: RepositoryConfigurationField;
  configurationIssue?: RepositoryConfigurationIssue;
}

export interface SafeErrorCause {
  type: string;
  code?: string;
  message: string;
}

export type ConnectionFlowStage =
  | "operation-lock"
  | "configuration"
  | "repository-discovery"
  | "repository-verification"
  | "write-probe"
  | "repository-create"
  | "settings-apply"
  | "repository-bind";

export type ConnectionInitializationStep = "saved-repository-binding" | "s3-client";

export type LocalPersistenceStep = "durable-state" | "plugin-data-validation" | "plugin-data-write";

export type SyncAction = "pull" | "push";

export type SyncFlowStage =
  | "preflight"
  | "repository-selection"
  | "repository-verification"
  | "outbox-replay"
  | "remote-list"
  | "remote-state-persistence"
  | "path-planning"
  | "local-apply"
  | "active-file-validation"
  | "stable-capture"
  | "remote-refresh"
  | "conflict-check"
  | "outbox-freeze"
  | "publication"
  | "publication-verification"
  | "local-persistence";

export class SyncFlowError extends Error {
  readonly kind = "sync-flow";
  readonly failure: SafeErrorRecord;

  constructor(readonly syncAction: SyncAction, readonly syncStage: SyncFlowStage, readonly cause: unknown) {
    super("sync flow failed");
    this.name = "SyncFlowError";
    this.failure = safeErrorRecord(cause);
  }
}

export function withSyncFlowStage(action: SyncAction, stage: SyncFlowStage, error: unknown): SyncFlowError {
  return error instanceof SyncFlowError ? error : new SyncFlowError(action, stage, error);
}

export class LocalPersistenceError extends Error {
  readonly kind = "local-persistence";
  readonly failure: SafeErrorRecord;

  constructor(readonly persistenceStep: LocalPersistenceStep, readonly cause: unknown) {
    super("local persistence failed");
    this.name = "LocalPersistenceError";
    this.failure = safeErrorRecord(cause);
  }
}

export function withLocalPersistenceStep(step: LocalPersistenceStep, error: unknown): LocalPersistenceError {
  return error instanceof LocalPersistenceError ? error : new LocalPersistenceError(step, error);
}

export class ConnectionInitializationError extends Error {
  readonly kind = "connection-initialization";
  readonly failure: SafeErrorRecord;

  constructor(readonly initializationStep: ConnectionInitializationStep, readonly cause: unknown) {
    super("connection initialization failed");
    this.name = "ConnectionInitializationError";
    this.failure = safeErrorRecord(cause);
  }
}

export function withConnectionInitializationStep(
  step: ConnectionInitializationStep,
  error: unknown,
): ConnectionInitializationError {
  return error instanceof ConnectionInitializationError ? error : new ConnectionInitializationError(step, error);
}

export class ConnectionFlowError extends Error {
  readonly kind = "connection-flow";
  readonly failure: SafeErrorRecord;

  constructor(readonly connectionStage: ConnectionFlowStage, readonly cause: unknown) {
    super("connection flow failed");
    this.name = "ConnectionFlowError";
    this.failure = safeErrorRecord(cause);
  }
}

export function withConnectionFlowStage(stage: ConnectionFlowStage, error: unknown): ConnectionFlowError {
  return error instanceof ConnectionFlowError ? error : new ConnectionFlowError(stage, error);
}

const categoryMessages: Record<SyncDiagnosticCategory, string> = {
  authentication: "认证或权限失败；凭证值未写入日志。",
  network: "网络请求失败；请检查连接后重试。",
  "rate-limit": "服务端正在限流；请等待退避后重试。",
  integrity: "完整性校验失败；相关远端对象已隔离。",
  "repository-identity": "仓库身份校验失败；写入已暂停。",
  "local-path": "本地路径或文件状态无法安全确认。",
  conflict: "检测到并发或待协调状态。",
  cancelled: "操作已取消。",
  internal: "插件内部流程失败；请求不一定已经发出。请复制错误报告供开发排查。",
};

export function safeErrorMessage(error: unknown): string {
  const record = safeErrorRecord(error);
  if (record.syncAction && record.syncStage) return safeSyncErrorMessage(error);
  const request = record.operation && record.stage ? `（${record.operation}/${record.stage}）` : "";
  return `${genericReasonMessage(record) ?? categoryMessages[record.category]}${request}`;
}

export function safeSyncErrorMessage(error: unknown): string {
  const record = safeErrorRecord(error);
  const action = record.syncAction === "pull" ? "拉取" : record.syncAction === "push" ? "上传" : "同步";
  const summary = outboxReplayMessage(record) ?? syncFlowMessage(record) ?? categoryMessages[record.category];
  const operationDetail = record.operation ? connectionOperationMessage(record) : undefined;
  const metadata = [
    record.syncAction ? `动作=${record.syncAction}` : undefined,
    record.syncStage ? `流程=${record.syncStage}` : undefined,
    record.preflightBlocker ? `阻断=${record.preflightBlocker}` : undefined,
    record.outboxStage ? `Outbox阶段=${record.outboxStage}` : undefined,
    record.persistenceStep ? `本地保存=${record.persistenceStep}` : undefined,
    record.operation ? `操作=${record.operation.toUpperCase()}` : undefined,
    record.stage ? `阶段=${record.stage}` : undefined,
    record.status ? `HTTP=${record.status}` : undefined,
    record.retries !== undefined ? `重试=${record.retries}` : undefined,
    record.requestId ? `RequestId=${record.requestId}` : undefined,
  ].filter((value): value is string => value !== undefined);
  const detail = operationDetail && operationDetail !== summary ? ` ${operationDetail}` : "";
  return `${action}失败：${summary}${detail}${metadata.length > 0 ? `（${metadata.join("，")}）` : ""}`;
}

export function safeSyncErrorReport(error: unknown): string {
  const record = safeErrorRecord(error);
  return JSON.stringify({
    type: "s3-sync-operation-error",
    schemaVersion: 3,
    code: stableErrorCode("operation", record),
    message: safeSyncErrorMessage(error),
    ...record,
    causes: safeErrorCauses(error),
  }, null, 2);
}

export function safeConnectionErrorMessage(error: unknown): string {
  const record = safeErrorRecord(error);
  const configurationMessage = connectionConfigurationMessage(record);
  const initializationMessage = connectionInitializationMessage(record);
  const persistenceMessage = connectionPersistenceMessage(record);
  const flowMessage = connectionFlowMessage(record);
  const specificFlowMessage = record.reasonCode === "REPOSITORY_DISCOVERY_INCOMPLETE"
    || record.reasonCode === "CONNECTION_APPLY_ROLLBACK_FAILED"
    || record.reasonCode === "OBJECT_STORE_PAGINATION_TOKEN_REPEATED"
    ? flowMessage
    : undefined;
  const summary = configurationMessage
    ?? initializationMessage
    ?? persistenceMessage
    ?? specificFlowMessage
    ?? (!record.operation ? flowMessage : undefined)
    ?? connectionOperationMessage(record);
  const operationDetail = record.operation ? connectionOperationMessage(record) : undefined;
  const metadata = [
    record.connectionStage ? `流程=${record.connectionStage}` : undefined,
    record.initializationStep ? `初始化=${record.initializationStep}` : undefined,
    record.persistenceStep ? `本地保存=${record.persistenceStep}` : undefined,
    record.operation ? `操作=${record.operation.toUpperCase()}` : undefined,
    record.stage ? `阶段=${record.stage}` : undefined,
    record.status ? `HTTP=${record.status}` : undefined,
    record.retries !== undefined ? `重试=${record.retries}` : undefined,
    record.requestId ? `RequestId=${record.requestId}` : undefined,
  ].filter((value): value is string => value !== undefined);
  const detail = operationDetail && operationDetail !== summary ? ` ${operationDetail}` : "";
  return `${summary}${detail}${metadata.length > 0 ? `（${metadata.join("，")}）` : ""}`;
}

export function safeConnectionErrorReport(error: unknown): string {
  const record = safeErrorRecord(error);
  return JSON.stringify({
    type: "s3-sync-connection-error",
    schemaVersion: 3,
    code: stableErrorCode("connection", record),
    message: safeConnectionErrorMessage(error),
    ...record,
    causes: safeErrorCauses(error),
  }, null, 2);
}

export function safeGenericErrorReport(error: unknown, context = "runtime"): string {
  const record = safeErrorRecord(error);
  return JSON.stringify({
    type: "s3-sync-error",
    schemaVersion: 3,
    code: stableErrorCode(context, record),
    message: safeErrorMessage(error),
    ...record,
    causes: safeErrorCauses(error),
  }, null, 2);
}

export function safeErrorCauses(error: unknown): SafeErrorCause[] {
  const causes: SafeErrorCause[] = [];
  const visited = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0 && causes.length < 8) {
    const current = pending.shift();
    if (current === undefined || current === null || visited.has(current)) continue;
    visited.add(current);
    const value = isRecord(current) ? current : {};
    const type = safeTypeName(value.name) ?? safeTypeName(value.kind) ?? typeof current;
    const code = safeToken(value.code, 96, /^[A-Za-z0-9._-]+$/)
      ?? safeToken(value.kind, 96, /^[A-Za-z0-9._-]+$/);
    causes.push(compactCause({ type, code, message: safeCauseMessage(value) }));
    if (value.cause !== undefined && value.cause !== null) pending.push(value.cause);
    if (Array.isArray(value.errors)) pending.push(...value.errors);
  }
  return causes;
}

export function safeErrorRecord(error: unknown): SafeErrorRecord {
  return safeErrorRecordInternal(error, new Set());
}

function safeErrorRecordInternal(error: unknown, visited: Set<unknown>): SafeErrorRecord {
  if (error !== null && typeof error === "object") {
    if (visited.has(error)) return { category: "internal" };
    visited.add(error);
  }
  const value = isRecord(error) ? error : {};
  if (value.kind === "sync-flow" && isRecord(value.failure)) {
    return compact({
      category: isDiagnosticCategory(value.failure.category) ? value.failure.category : "internal",
      reasonCode: safeReasonCode(value.failure.reasonCode),
      syncAction: isSyncAction(value.syncAction) ? value.syncAction : undefined,
      syncStage: isSyncFlowStage(value.syncStage) ? value.syncStage : undefined,
      preflightBlocker: isSyncPreflightBlocker(value.failure.preflightBlocker)
        ? value.failure.preflightBlocker
        : undefined,
      outboxStage: isDurableOutboxReplayStage(value.failure.outboxStage) ? value.failure.outboxStage : undefined,
      persistenceStep: isLocalPersistenceStep(value.failure.persistenceStep) ? value.failure.persistenceStep : undefined,
      operation: isObjectStoreOperation(value.failure.operation) ? value.failure.operation : undefined,
      stage: safeToken(value.failure.stage, 64, /^[A-Za-z0-9._-]+$/),
      status: safeInteger(value.failure.status, 100, 599),
      requestId: safeToken(value.failure.requestId, 256, /^[A-Za-z0-9+=_-]+$/),
      retries: safeInteger(value.failure.retries, 0, 100),
    });
  }
  if (value.kind === "durable-outbox-replay") {
    const failure = safeErrorRecordInternal(value.cause, visited);
    const outboxStage = isDurableOutboxReplayStage(value.outboxStage) ? value.outboxStage : undefined;
    const localStage = outboxStage === "durable-open" || outboxStage === "begin"
      || outboxStage === "staged-verify" || outboxStage === "durable-confirm" || outboxStage === "reconcile";
    return compact({
      ...failure,
      category: localStage && (failure.category === "network" || failure.category === "internal")
        ? "local-path"
        : failure.category,
      outboxStage,
    });
  }
  if (value.kind === "sync-preflight") {
    const blocker = isSyncPreflightBlocker(value.blocker) ? value.blocker : undefined;
    return compact({
      category: blocker ? syncPreflightCategory(blocker) : "local-path",
      preflightBlocker: blocker,
    });
  }
  if (value.kind === "connection-flow" && isRecord(value.failure)) {
    return compact({
      category: isDiagnosticCategory(value.failure.category) ? value.failure.category : "internal",
      reasonCode: safeReasonCode(value.failure.reasonCode),
      connectionStage: isConnectionFlowStage(value.connectionStage) ? value.connectionStage : undefined,
      initializationStep: isConnectionInitializationStep(value.failure.initializationStep)
        ? value.failure.initializationStep
        : undefined,
      persistenceStep: isLocalPersistenceStep(value.failure.persistenceStep) ? value.failure.persistenceStep : undefined,
      operation: isObjectStoreOperation(value.failure.operation) ? value.failure.operation : undefined,
      stage: safeToken(value.failure.stage, 64, /^[A-Za-z0-9._-]+$/),
      status: safeInteger(value.failure.status, 100, 599),
      requestId: safeToken(value.failure.requestId, 256, /^[A-Za-z0-9+=_-]+$/),
      retries: safeInteger(value.failure.retries, 0, 100),
      configurationField: isConfigurationField(value.failure.configurationField) ? value.failure.configurationField : undefined,
      configurationIssue: isConfigurationIssue(value.failure.configurationIssue) ? value.failure.configurationIssue : undefined,
    });
  }
  if (value.kind === "connection-initialization" && isRecord(value.failure)) {
    const initializationStep = isConnectionInitializationStep(value.initializationStep)
      ? value.initializationStep
      : undefined;
    return compact({
      category: initializationStep === "saved-repository-binding"
        ? "repository-identity"
        : isDiagnosticCategory(value.failure.category) ? value.failure.category : "internal",
      reasonCode: safeReasonCode(value.failure.reasonCode),
      initializationStep,
      operation: isObjectStoreOperation(value.failure.operation) ? value.failure.operation : undefined,
      stage: safeToken(value.failure.stage, 64, /^[A-Za-z0-9._-]+$/),
      status: safeInteger(value.failure.status, 100, 599),
      requestId: safeToken(value.failure.requestId, 256, /^[A-Za-z0-9+=_-]+$/),
      retries: safeInteger(value.failure.retries, 0, 100),
      configurationField: isConfigurationField(value.failure.configurationField) ? value.failure.configurationField : undefined,
      configurationIssue: isConfigurationIssue(value.failure.configurationIssue) ? value.failure.configurationIssue : undefined,
    });
  }
  if (value.kind === "local-persistence" && isRecord(value.failure)) {
    return compact({
      category: "local-path",
      reasonCode: safeReasonCode(value.failure.reasonCode),
      persistenceStep: isLocalPersistenceStep(value.persistenceStep) ? value.persistenceStep : undefined,
      operation: isObjectStoreOperation(value.failure.operation) ? value.failure.operation : undefined,
      stage: safeToken(value.failure.stage, 64, /^[A-Za-z0-9._-]+$/),
      status: safeInteger(value.failure.status, 100, 599),
      requestId: safeToken(value.failure.requestId, 256, /^[A-Za-z0-9+=_-]+$/),
      retries: safeInteger(value.failure.retries, 0, 100),
      configurationField: isConfigurationField(value.failure.configurationField) ? value.failure.configurationField : undefined,
      configurationIssue: isConfigurationIssue(value.failure.configurationIssue) ? value.failure.configurationIssue : undefined,
    });
  }
  if (value.name === "AggregateError" && Array.isArray(value.errors)) {
    const failures = value.errors
      .map((cause) => safeErrorRecordInternal(cause, visited))
      .filter((failure) => failure.category !== "internal" || Object.keys(failure).length > 1);
    return failures.find((failure) => failure.operation !== undefined)
      ?? failures.find((failure) => failure.persistenceStep !== undefined)
      ?? failures[0]
      ?? { category: "internal" };
  }
  const details = isRecord(value.details) ? value.details : {};
  const connectionConfiguration = value.kind === "connection-configuration";
  const configurationField = connectionConfiguration && isConfigurationField(value.field) ? value.field : undefined;
  const inherited = value.kind === "diagnostic" && value.cause !== undefined
    ? safeErrorRecordInternal(value.cause, visited)
    : undefined;
  return compact({
    ...inherited,
    category: configurationField === "access-key-id" || configurationField === "secret-access-key"
      ? "authentication"
      : diagnosticCategory(error),
    reasonCode: connectionConfiguration && configurationField && isConfigurationIssue(value.issue)
      ? `configuration-${configurationField}-${value.issue}`
      : safeReasonCode(value.code) ?? inherited?.reasonCode,
    operation: isObjectStoreOperation(value.operation) ? value.operation : inherited?.operation,
    stage: safeToken(details.stage, 64, /^[A-Za-z0-9._-]+$/) ?? inherited?.stage,
    status: safeInteger(details.status, 100, 599) ?? inherited?.status,
    requestId: safeToken(details.requestId, 256, /^[A-Za-z0-9+=_-]+$/) ?? inherited?.requestId,
    retries: safeInteger(details.retries, 0, 100) ?? inherited?.retries,
    configurationField: configurationField ?? inherited?.configurationField,
    configurationIssue: connectionConfiguration && isConfigurationIssue(value.issue)
      ? value.issue
      : inherited?.configurationIssue,
  });
}

export function logSafeError(label: string, error: unknown): void {
  console.error(label, safeErrorRecord(error));
}

function compact(value: SafeErrorRecord): SafeErrorRecord {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as unknown as SafeErrorRecord;
}

function compactCause(value: SafeErrorCause): SafeErrorCause {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as unknown as SafeErrorCause;
}

function stableErrorCode(context: string, record: SafeErrorRecord): string {
  const parts = [
    "S3SYNC",
    context,
    record.syncAction,
    record.syncStage,
    record.connectionStage,
    record.initializationStep,
    record.persistenceStep,
    record.preflightBlocker,
    record.outboxStage,
    record.operation,
    record.stage,
    record.reasonCode,
    record.category,
  ].filter((value): value is string => !!value);
  return parts.join("_").replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
}

function safeTypeName(value: unknown): string | undefined {
  return safeToken(value, 96, /^[A-Za-z][A-Za-z0-9._-]*$/);
}

function redactDiagnosticText(value: string): string {
  const redacted = value
    .replace(/(?:https?|s3):\/\/[^\s,;]+/gi, "[endpoint-redacted]")
    .replace(/[A-Za-z]:[\\/][^\s,;]+/g, "[path-redacted]")
    .replace(/(^|\s)\/(?:[^\s,;]+\/)*[^\s,;]*/g, "$1[path-redacted]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[access-key-redacted]")
    .replace(/(secret|password|token|credential|access.?key)(\s*[=:]\s*)[^\s,;]+/gi, "$1$2[redacted]");
  return redacted.slice(0, 500) || "empty error message";
}

function safeCauseMessage(value: Record<string, unknown>): string {
  if (value.name === "AggregateError") return "multiple failures";
  const controlledKinds = new Set([
    "diagnostic",
    "sync-flow",
    "connection-flow",
    "connection-initialization",
    "connection-configuration",
    "local-persistence",
    "durable-outbox-replay",
    "sync-preflight",
  ]);
  const controlledNames = new Set([
    "DiagnosticError",
    "SyncFlowError",
    "ConnectionFlowError",
    "ConnectionInitializationError",
    "RepositoryConfigurationError",
    "LocalPersistenceError",
    "DurableOutboxReplayError",
    "SyncPreflightError",
    "ObjectStoreError",
  ]);
  const controlled = controlledKinds.has(String(value.kind)) || controlledNames.has(String(value.name));
  if (!controlled || typeof value.message !== "string") return "untyped error details redacted";
  return redactDiagnosticText(value.message);
}

function safeReasonCode(value: unknown): string | undefined {
  return safeToken(value, 96, /^[A-Za-z0-9._-]+$/);
}

function safeToken(value: unknown, maximumLength: number, pattern: RegExp): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) return undefined;
  return pattern.test(value) ? value : undefined;
}

function safeInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? value as number
    : undefined;
}

function connectionConfigurationMessage(record: SafeErrorRecord): string | undefined {
  const key = `${record.configurationField ?? ""}:${record.configurationIssue ?? ""}`;
  return {
    "endpoint:required": "Endpoint 未填写。",
    "endpoint:invalid-url": "Endpoint 不是有效的完整 URL；应形如 https://s3.example.com。",
    "endpoint:https-required": "Endpoint 必须使用 HTTPS；只有 127.0.0.1 或 localhost 可使用 HTTP。",
    "endpoint:origin-only": "Endpoint 只能包含协议、主机和可选端口；请移除末尾 /、Bucket、路径、查询参数及用户名密码。",
    "region:invalid-region": "Region 格式无效；只能使用 1 至 128 个字母、数字、点、下划线或连字符。",
    "bucket:required": "Bucket 未填写。",
    "bucket:invalid-bucket": "Bucket 格式无效；只能填写 Bucket 名称，不能包含 / 或反斜杠。",
    "prefix:invalid-prefix": "Prefix 格式无效；不能包含空路径段、`.`、`..`、反斜杠或控制字符。",
    "access-key-id:required": "Access Key ID 未填写。",
    "secret-access-key:required": "Secret Access Key 未填写；复制的错误报告不会包含凭证值。",
  }[key];
}

function genericReasonMessage(record: SafeErrorRecord): string | undefined {
  if (record.reasonCode?.startsWith("CONFLICT_APPLY_")) {
    return "所选冲突候选未能安全应用；原文件前像和冲突状态均已保留。";
  }
  return {
    PLUGIN_DATA_READ_FAILED: "Obsidian 无法读取插件 data.json；插件已进入未连接只读状态，原文件未被改写。",
    PLUGIN_DATA_SCHEMA_INVALID: "插件 data.json 未通过当前严格 schema；插件已进入未连接只读状态，原文件未被改写。",
    SAVED_REPOSITORY_BINDING_INVALID: "保存的仓库绑定与当前 Vault 配置目录不一致；本次不会访问 S3，请使用新 Prefix 重新执行“检测并应用”。",
    REPOSITORY_STATE_RESTORE_FAILED: "本地仓库状态读取失败；为避免覆盖因果状态，本次不会访问 S3。",
    REPOSITORY_STATE_ARCHIVED_AND_RESET: "本地仓库状态损坏或格式不受支持；异常副本已归档并建立新的本地 writer。",
    CONFLICT_NOT_FOUND: "该冲突已不存在或已由另一操作解决；请刷新冲突窗口。",
    CONFLICT_REPOSITORY_NOT_CONNECTED: "当前未连接仓库，不能解决冲突；请先执行“检测并应用”。",
    CONFLICT_REMOTE_CHANGED: "远端冲突头或候选已经变化；未应用所选版本，请重新检查并选择。",
    CONFLICT_CANDIDATE_REQUIRED: "尚未选择有效的远端冲突候选。",
    CONFLICT_LOCAL_PATH_OCCUPIED: "冲突路径被目录或其他非文件条目占用；未覆盖现有内容。",
    CONFLICT_LOCAL_CAPTURE_CHANGED: "读取本地冲突文件期间内容再次变化；未发布解决结果，请重试。",
    CONFLICT_SELECTED_REMOTE_CHANGED: "所选远端候选应用后发生了新的本地变化；未发布解决结果，请重新检查。",
    CONFLICT_LOCAL_VERSION_CHANGED: "本地冲突版本已经变化或无法稳定读取；未发布解决结果，请重新检查。",
    REPOSITORY_OPERATION_BUSY: "已有同步、检查或配置操作正在运行；本次操作尚未开始。",
    CONFIG_PROFILE_INVALID: "配置同步范围未通过校验；设置未保存。",
    CONFIG_LOCAL_VIEW_MISSING: "本地配置扫描未生成可验证的 ConfigTree；未继续访问或发布配置。",
    CONFIG_REPOSITORY_BINDING_CHANGED: "仓库绑定在配置操作期间发生变化；本次操作已安全停止。",
    CONFIG_MERGE_SNAPSHOT_REQUIRED: "配置冲突快照已经过期；请刷新配置中心后重新合并。",
    CONFIG_MERGE_BYTES_MISSING: "配置合并候选缺少已验证字节；候选未发布。",
    CONFIG_REPOSITORY_NOT_CONNECTED: "当前未连接仓库，不能执行配置操作；请先执行“检测并应用”。",
    CONFIG_RECOVERY_BLOCKS_PUBLICATION: "存在未完成的配置恢复；恢复完成前不能发布新快照。",
    CONFIG_PUBLICATION_CONFIRMATION_EXPIRED: "配置发布确认已经过期；候选未发布，请重新预览确认。",
    CONFIG_PLUGIN_CODE_CONFIRMATION_REQUIRED: "配置包含插件代码；必须单独确认后才能发布。",
    CONFIG_SENSITIVE_DATA_CONFIRMATION_REQUIRED: "配置包含可能敏感的 plugin data；必须确认明文远端存储风险后才能发布。",
    CONFIG_TARGET_INCOMPATIBLE: "目标 ConfigTree 与当前设备或 Obsidian 版本不兼容；未应用或发布。",
    CONFIG_REMOTE_HEADS_CHANGED: "远端配置头在确认后发生变化；候选未发布，请刷新。",
    CONFIG_REMOTE_REGISTER_BLOCKED: "远端配置仍有待验证依赖或无效版本；不能发布解决版本。",
    CONFIG_LOCAL_TREE_CHANGED: "本地配置在确认后发生变化；候选未发布，请重新预览。",
    CONFIG_FROZEN_TREE_MISMATCH: "冻结的 ConfigTree 与确认预览不一致；Outbox 未写入。",
    CONFIG_APPLY_STATE_BLOCKED: "当前配置状态存在冲突、待依赖、不兼容或恢复项；不能应用。",
    CONFIG_RESOLVED_REMOTE_MISSING: "当前没有可应用的已解析远端 ConfigTree。",
    CONFIG_REMOTE_TARGET_CHANGED: "所选远端 ConfigTree 已变化；未应用，请刷新配置中心。",
    CONFIG_COMMUNITY_PLUGINS_PATH_INVALID: "community-plugins.json 被目录或其他非文件条目占用；未覆盖现有内容。",
    CONFIG_APPLY_CONFIRMATION_EXPIRED: "配置应用确认已经过期；未写入文件，请重新预览确认。",
    CONFIG_RECOVERY_BATCH_MISSING: "当前没有可继续或回滚的配置批次。",
    CONFIG_RECOVERY_TARGET_MISSING: "配置恢复记录缺少目标 ConfigTree；请保留恢复目录并复制报告。",
    CONFIG_STAGED_CONTENT_MISMATCH: "配置暂存内容未通过 Hash/大小校验；未写入正式配置路径。",
    CONFIG_PUBLICATION_OUTBOX_UNVERIFIED: "配置发布 Outbox 尚未通过远端验证；本地状态和暂存内容均已保留。",
    CONFIG_PUBLICATION_LOCAL_RECHECK_INCOMPLETE: "配置已发布，但发布后的本地复查未完成；请保留本地状态并安全重试。",
    CONFIG_DESKTOP_RUNTIME_REQUIRED: "配置应用需要桌面版 Obsidian 的 FileSystemAdapter；当前平台只能预览。",
    CONTENT_STAGING_DESKTOP_RUNTIME_REQUIRED: "持久暂存需要桌面版 Obsidian；当前平台不能执行发布或应用。",
    VAULT_APPLY_DESKTOP_RUNTIME_REQUIRED: "Vault 安全应用需要桌面版 Obsidian；当前平台不能写入文件。",
    VAULT_STAGED_REFERENCE_REPOSITORY_MISMATCH: "Vault 暂存引用属于另一仓库状态目录；未写入正式路径。",
    DURABLE_OUTBOX_REPOSITORY_CHANGED: "Outbox 恢复前仓库绑定发生变化；自动重放已停止。",
    DURABLE_OUTBOX_REPOSITORY_MISSING: "Outbox 恢复期间仓库绑定丢失；自动重放已停止。",
    DURABLE_OUTBOX_COMMIT_NOT_ACCEPTED: "Outbox Commit 未进入已验证提交前沿；发布确认未写入本地。",
    DURABLE_OUTBOX_SNAPSHOT_REPOSITORY_MISMATCH: "Outbox 状态快照属于另一仓库绑定；未应用该快照。",
    VAULT_PUBLICATION_RECONCILE_INCOMPLETE: "文件已发布，但本地发布对账尚未完成；Outbox 与本地变化记录均已保留。",
    VAULT_DELETION_RECONCILE_INCOMPLETE: "删除已发布，但本地发布对账尚未完成；Outbox 与本地变化记录均已保留。",
    PUBLISHED_VAULT_OUTBOX_METADATA_INCOMPLETE: "已发布 Outbox 的 Vault 变更元数据不完整；自动对账已停止。",
    PUBLISHED_VAULT_OUTBOX_BLOB_MISSING: "已发布 Outbox 缺少对应 Blob 元数据；自动对账已停止。",
    REPOSITORY_PREFIX_NOT_CONNECTED: "当前 Prefix 尚未连接到已验证仓库；请先执行“检测并应用”。",
    LOCAL_CONCURRENT_RECORD_UNRESOLVED: "当前文件仍有本地并发记录；解决后才能发布。",
    PUBLISHED_MUTATION_RECONCILE_PENDING: "上次发布仍在等待本地对账；本次不会重复上传。",
    VAULT_CONFLICT_UNRESOLVED: "当前文件仍有未解决冲突；本次不会上传。",
    VAULT_STAGING_CAPTURE_FAILED: "当前文件无法稳定写入持久暂存；Outbox 尚未冻结。",
    AUTO_SYNC_DELAY_INVALID: "自动同步调度参数无效；调度器未启动，请复制报告供开发排查。",
    REPOSITORY_OPERATION_RUNTIME_DISPOSED: "仓库操作运行时已经停止；请重新加载插件后重试。",
    REPOSITORY_OPERATION_SIGNAL_MISSING: "仓库操作缺少取消信号；本次操作已停止，请复制报告供开发排查。",
    REPOSITORY_OPERATION_OWNERSHIP_INVALID: "仓库操作锁所有权异常；本次操作已停止，请复制报告供开发排查。",
    REPOSITORY_OPERATION_CANCELLED: "仓库操作已取消；未完成步骤不会继续执行。",
    RUNTIME_CONTRACT_CONFIG_DIR_MISSING: "Vault 的 configDir 为空；运行环境检查无法继续。",
    CONFIG_TREE_HASH_COLLISION: "相同 ConfigTree Hash 对应不同对象；远端配置已按完整性错误隔离。",
    CONFIG_TREE_BLOB_REFERENCE_MISSING: "ConfigTree 文件项缺少 Blob 引用；未应用或发布。",
    CONFIG_TREE_BLOB_BYTES_MISSING: "ConfigTree 对应的已验证 Blob 字节不可用；未应用或发布。",
    CONFIG_TREE_STAGED_BLOB_MISMATCH: "ConfigTree 暂存 Blob 未通过 Hash/大小校验；未应用或发布。",
    CONFIG_TREE_STAGED_REFERENCE_MISSING: "ConfigTree 文件项缺少本地暂存引用；未应用或发布。",
    REPOSITORY_ALREADY_EXISTS: "当前 Prefix 已出现仓库，可能由另一客户端刚刚创建；请重新执行“检测并应用”。",
    REMOTE_VAULT_REGISTER_UNRESOLVED: "远端文件寄存器仍有并发、待依赖或无效版本；本次不会发布。",
    TERMINAL_OUTBOX_STATE_INVALID: "终止 Outbox 恢复收到非终止状态；自动恢复已停止。",
    TERMINAL_OUTBOX_REPOSITORY_MISMATCH: "终止 Outbox 属于另一仓库绑定；自动恢复已停止。",
    DURABLE_OUTBOX_REPLAY_SIZE_MISMATCH: "Outbox 暂存字节超过冻结大小；自动重放已停止。",
    DURABLE_OUTBOX_REPLAY_CONTENT_MISMATCH: "Outbox 暂存字节未通过冻结 Hash/大小校验；自动重放已停止。",
  }[record.reasonCode ?? ""];
}

function connectionInitializationMessage(record: SafeErrorRecord): string | undefined {
  if (!record.initializationStep) return undefined;
  return {
    "saved-repository-binding": "本机仓库绑定不完整；Endpoint、Region 和 Bucket 尚未发起检测。请重新执行“检测并应用”。",
    "s3-client": "S3 客户端在本机初始化失败，请求尚未发出；这是插件运行时或 Bundle 初始化问题，不是网络连通性错误。",
  }[record.initializationStep];
}

function connectionPersistenceMessage(record: SafeErrorRecord): string | undefined {
  if (!record.persistenceStep) return undefined;
  return {
    "durable-state": "远端检测已通过，但本地仓库状态创建、校验或回读失败；检测结果尚未应用。",
    "plugin-data-validation": "远端检测已通过，但本地 data.json 在写入前未通过安全边界校验；未写入新配置。",
    "plugin-data-write": "远端检测和本地状态校验已通过，但 Obsidian 写入插件 data.json 失败。",
  }[record.persistenceStep];
}

function connectionOperationMessage(record: SafeErrorRecord): string {
  const probeMessage: Partial<Record<string, string>> = {
    "atomic-create-unverified": "当前 ObjectStore adapter 未声明已验证的原子创建能力，写模式已拒绝。",
    "atomic-create-no-winner": "两个并发条件 PUT 都没有成功；请检查写权限、条件写兼容性和服务状态。",
    "atomic-create-multiple-winners": "存储同时接受了两个不同正文的条件 PUT，不满足当前协议的原子不可变写入要求。",
    "atomic-create-loser-missing": "并发条件 PUT 没有产生可验证的失败方，无法证明原子创建语义。",
    "atomic-create-loser-unclassified": "一个条件 PUT 成功，但另一个请求的失败方式不能证明对象未被覆盖。",
    "probe-readback": "probe 对象回读的字节或 Hash 与写入内容不一致。",
    "probe-size": "probe 对象的 HEAD 大小与写入内容不一致。",
    "probe-not-visible": "probe 对象写入并回读成功，但没有在 LIST 中可见。",
    verify: "条件 PUT 返回成功后，远端字节被另一请求改变；无法证明原子创建语义。",
  };
  if (record.stage && probeMessage[record.stage]) return probeMessage[record.stage]!;
  if (record.operation === "list" && record.stage === "pagination-token") {
    return "S3 LIST 分页返回了重复游标；为避免无限循环，操作已停止。请检查对象存储或网关的 ListObjectsV2 分页兼容性。";
  }
  if (record.category === "authentication") {
    return "S3 认证或权限失败；请检查 Access Key、Secret、Region、系统时间及对应操作权限。";
  }
  if (record.category === "rate-limit") return "S3 服务正在限流或暂时不可用；请稍后重试。";
  if (record.status !== undefined) {
    if (record.operation === "list") return "S3 LIST 请求失败；请检查 Endpoint、Region、Bucket、Path-style、DNS/TLS 和 ListBucket 权限。";
    if (record.operation === "put") return "S3 PUT 请求失败；请检查 PutObject 权限和 If-None-Match: * 条件写兼容性。";
    if (record.operation === "get") return "S3 GET 请求失败；请检查 GetObject 权限、代理和服务回读能力。";
    if (record.operation === "head") return "S3 HEAD 请求失败；请检查 GetObject/HeadObject 权限和网关兼容性。";
  }
  if (record.category === "integrity") {
    return record.operation === "put"
      ? "S3 条件写入未满足不可变对象要求；请检查 If-None-Match: * 兼容性。"
      : "S3 回读内容或元数据未通过完整性校验。";
  }
  if (record.category === "repository-identity") return "当前连接未能验证已绑定仓库的 descriptor 或提交锚点。";
  if (record.operation === "list") return "S3 LIST 请求失败；请检查 Endpoint、Region、Bucket、Path-style、DNS/TLS 和 ListBucket 权限。";
  if (record.operation === "put") return "S3 PUT 请求失败；请检查 PutObject 权限和 If-None-Match: * 条件写兼容性。";
  if (record.operation === "get") return "S3 GET 请求失败；请检查 GetObject 权限、代理和服务回读能力。";
  if (record.operation === "head") return "S3 HEAD 请求失败；请检查 GetObject/HeadObject 权限和网关兼容性。";
  return categoryMessages[record.category];
}

function connectionFlowMessage(record: SafeErrorRecord): string | undefined {
  const genericMessage = genericReasonMessage(record);
  if (genericMessage) return genericMessage;
  if (record.reasonCode === "OBJECT_STORE_PAGINATION_TOKEN_REPEATED") {
    return "S3 LIST 分页返回了重复游标；为避免无限循环，操作已停止。请检查对象存储或网关的 ListObjectsV2 分页兼容性。";
  }
  if (record.reasonCode === "REPOSITORY_DISCOVERY_INCOMPLETE") {
    return "Prefix 中存在无法完整验证的仓库描述符；为避免误建第二个仓库，检测已停止且不会把该 Prefix 当作空仓库。";
  }
  if (record.reasonCode === "CONNECTION_APPLY_ROLLBACK_FAILED") {
    return "远端检测后的本地应用失败，恢复旧连接配置时写入 data.json 也失败；内存配置已还原，请保留 data.json 并复制本报告。";
  }
  if (!record.connectionStage) return undefined;
  return {
    "operation-lock": "已有同步、校验或仓库操作正在运行；请等待其结束后重试。",
    configuration: "连接配置初始化失败，但没有产生可识别的字段错误。",
    "repository-discovery": "连接已进入仓库发现阶段，但尚未获得可识别的 S3 请求错误。",
    "repository-verification": "已发现仓库，但 descriptor 或提交锚点验证阶段失败。",
    "write-probe": "仓库读取阶段完成，但写入兼容性探针内部失败。",
    "repository-create": "连接和写入探针已通过，但远端仓库创建失败。",
    "settings-apply": "远端检测已通过，但本地连接设置保存或路由切换失败。",
    "repository-bind": "远端检测已通过，但本地仓库绑定持久化失败。",
  }[record.connectionStage];
}

function syncFlowMessage(record: SafeErrorRecord): string | undefined {
  const genericMessage = genericReasonMessage(record);
  if (genericMessage) return genericMessage;
  if (record.reasonCode === "OBJECT_STORE_PAGINATION_TOKEN_REPEATED") {
    return "S3 LIST 分页返回了重复游标；为避免无限循环，操作已停止。请检查对象存储或网关的 ListObjectsV2 分页兼容性。";
  }
  if (record.reasonCode === "CONFLICT_COPY_SOURCE_MISMATCH") {
    return "远端候选下载完成后未通过 Hash/大小校验；候选副本未写入，请复制报告排查远端对象。";
  }
  if (record.reasonCode === "CONFLICT_COPY_PATH_OCCUPIED") {
    return "冲突候选副本路径被目录或其他非文件条目占用；未覆盖现有内容。";
  }
  if (record.reasonCode === "CONFLICT_COPY_READ_FAILED") {
    return "已有冲突候选副本无法读取校验；未覆盖现有内容。";
  }
  if (record.reasonCode === "CONFLICT_COPY_CONTENT_MISMATCH") {
    return "已有冲突候选副本已被修改，不能再代表远端版本；请先重命名或移走该副本后重试。";
  }
  if (record.reasonCode === "REMOTE_STRUCTURAL_PATH_CONFLICT") {
    return "检测到文件/目录碰撞或大小写别名；本轮尚未写入本地，请先处理结构冲突。";
  }
  if (!record.syncStage) return undefined;
  return {
    preflight: syncPreflightMessage(record.preflightBlocker) ?? "同步前置检查未通过，但没有识别到具体阻断状态。",
    "repository-selection": "当前连接尚未绑定可用仓库；请先在连接设置中检测并应用。",
    "repository-verification": "已保存的仓库绑定验证失败。",
    "outbox-replay": "恢复上次未完成的上传失败；Outbox 仍保留，可安全重试。",
    "remote-list": "读取远端文件清单失败。",
    "remote-state-persistence": "远端状态已读取，但本地观察状态保存失败。",
    "path-planning": "计算本地与远端处理方案失败。",
    "local-apply": "下载或写入本地文件失败。",
    "active-file-validation": "当前文件检查未通过；请确认已打开普通 Vault 文件，且没有待解决冲突。",
    "stable-capture": "无法稳定读取当前文件；请等待文件写盘完成后重试。",
    "remote-refresh": "发布前复查远端版本失败。",
    "conflict-check": "发布前发现本地与远端均有变化；请先处理冲突。",
    "outbox-freeze": "本地待上传记录未能安全落盘；尚未开始本次远端发布。",
    publication: "远端对象或提交上传失败；本地 Outbox 已保留，可安全重试。",
    "publication-verification": "远端发布已发起，但回读验证或本地对账未完成；请勿手工覆盖远端对象。",
    "local-persistence": "远端操作已完成，但本地同步状态保存失败。",
  }[record.syncStage];
}

function syncPreflightMessage(blocker: SyncPreflightBlocker | undefined): string | undefined {
  if (!blocker) return undefined;
  return {
    "repository-state-recovery": "本地仓库状态暂时无法读取；为避免覆盖因果状态，本次不会访问 S3。请复制报告并在修复本地存储后重新加载插件。",
    "apply-journal-recovery": "检测到未完成的本地文件安全应用；原文件前像已保留，请在状态页核对恢复记录。",
    "config-journal-recovery": "检测到未完成的配置批次恢复；配置前像已保留，请在配置中心继续恢复。",
    "operational-recovery": "本地同步状态仍要求人工恢复；本次尚未读取远端候选。请复制“状态与检查”中的诊断包。",
    "repository-stopped": "本地同步协调器处于已停止状态；本次尚未读取远端候选。请重新加载插件后重试。",
  }[blocker];
}

function outboxReplayMessage(record: SafeErrorRecord): string | undefined {
  if (!record.outboxStage) return undefined;
  return {
    "durable-open": "恢复旧上传时无法打开本地持久状态；S3 请求尚未开始。",
    begin: "恢复旧上传时无法更新本地 Outbox 状态；S3 请求尚未开始。",
    descriptor: "恢复旧上传时仓库 descriptor 验证失败。",
    frontier: "恢复旧上传时提交前沿验证失败。",
    "staged-verify": "旧上传的本地暂存内容不可用，远端也没有可验证的完整副本；写入已停止，请复制报告供开发排查。",
    "remote-recovery-check": "本地暂存内容不可用，检查远端恢复副本时请求失败。",
    "terminal-remote-verify": "终止 Outbox 的远端不可变对象未全部通过 Hash/大小回读；状态保持原样，可继续只读检查远端候选。",
    "writer-binding": "检测到属于非活动 writer 的未完成 Outbox；自动恢复已停止，请复制报告排查本地持久状态。",
    put: "恢复旧上传时写入远端不可变对象失败；Outbox 仍保留。",
    "remote-verify": "旧上传已发起，但远端对象回读校验失败；Outbox 仍保留。",
    inspect: "旧上传对象已重放，但读取远端提交状态失败。",
    "durable-confirm": "旧上传已通过远端校验，但本地发布确认保存失败。",
    reconcile: "旧上传已确认，但本地文件状态对账失败。",
  }[record.outboxStage];
}

function isDiagnosticCategory(value: unknown): value is SyncDiagnosticCategory {
  return typeof value === "string" && [
    "authentication", "network", "rate-limit", "integrity", "repository-identity", "local-path", "conflict", "cancelled", "internal",
  ].includes(value);
}

function isConnectionFlowStage(value: unknown): value is ConnectionFlowStage {
  return typeof value === "string" && [
    "operation-lock", "configuration", "repository-discovery", "repository-verification", "write-probe", "repository-create", "settings-apply", "repository-bind",
  ].includes(value);
}

function isSyncAction(value: unknown): value is SyncAction {
  return value === "pull" || value === "push";
}

function isSyncFlowStage(value: unknown): value is SyncFlowStage {
  return typeof value === "string" && [
    "preflight", "repository-selection", "repository-verification", "outbox-replay", "remote-list",
    "remote-state-persistence", "path-planning", "local-apply", "active-file-validation", "stable-capture",
    "remote-refresh", "conflict-check", "outbox-freeze", "publication", "publication-verification", "local-persistence",
  ].includes(value);
}

function isDurableOutboxReplayStage(value: unknown): value is DurableOutboxReplayStage {
  return typeof value === "string" && [
    "durable-open", "begin", "descriptor", "frontier", "staged-verify", "remote-recovery-check",
    "terminal-remote-verify", "writer-binding", "put", "remote-verify", "inspect", "durable-confirm", "reconcile",
  ].includes(value);
}

function isConnectionInitializationStep(value: unknown): value is ConnectionInitializationStep {
  return typeof value === "string" && ["saved-repository-binding", "s3-client"].includes(value);
}

function isLocalPersistenceStep(value: unknown): value is LocalPersistenceStep {
  return typeof value === "string"
    && ["durable-state", "plugin-data-validation", "plugin-data-write"].includes(value);
}

function isObjectStoreOperation(value: unknown): value is NonNullable<SafeErrorRecord["operation"]> {
  return typeof value === "string" && ["list", "get", "head", "put", "delete-probe"].includes(value);
}

function isConfigurationField(value: unknown): value is RepositoryConfigurationField {
  return typeof value === "string"
    && ["endpoint", "region", "bucket", "prefix", "access-key-id", "secret-access-key"].includes(value);
}

function isConfigurationIssue(value: unknown): value is RepositoryConfigurationIssue {
  return typeof value === "string" && [
    "required", "invalid-url", "https-required", "origin-only", "invalid-region", "invalid-bucket", "invalid-prefix",
  ].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
