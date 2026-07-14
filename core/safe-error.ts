import { diagnosticCategory, type SyncDiagnosticCategory } from "./diagnostics";

export interface SafeErrorRecord {
  category: SyncDiagnosticCategory;
  operation?: string;
  stage?: string;
  status?: number;
  requestId?: string;
  retries?: number;
}

const categoryMessages: Record<SyncDiagnosticCategory, string> = {
  authentication: "认证或权限失败；凭证值未写入日志。",
  network: "网络请求失败；请检查连接后重试。",
  "rate-limit": "服务端正在限流；请等待退避后重试。",
  integrity: "完整性校验失败；相关远端对象已隔离。",
  "repository-identity": "仓库身份校验失败；写入已暂停。",
  "local-path": "本地路径或文件状态无法安全确认。",
  conflict: "检测到并发或待协调状态。",
};

export function safeErrorMessage(error: unknown): string {
  const record = safeErrorRecord(error);
  const request = record.operation && record.stage ? `（${record.operation}/${record.stage}）` : "";
  return `${categoryMessages[record.category]}${request}`;
}

export function safeErrorRecord(error: unknown): SafeErrorRecord {
  const value = isRecord(error) ? error : {};
  const details = isRecord(value.details) ? value.details : {};
  return compact({
    category: diagnosticCategory(error),
    operation: typeof value.operation === "string" && ["list", "get", "head", "put", "delete-probe"].includes(value.operation)
      ? value.operation
      : undefined,
    stage: safeToken(details.stage, 64, /^[A-Za-z0-9._-]+$/),
    status: safeInteger(details.status, 100, 599),
    requestId: safeToken(details.requestId, 256, /^[A-Za-z0-9+=_-]+$/),
    retries: safeInteger(details.retries, 0, 100),
  });
}

export function logSafeError(label: string, error: unknown): void {
  console.error(label, safeErrorRecord(error));
}

function compact(value: SafeErrorRecord): SafeErrorRecord {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as unknown as SafeErrorRecord;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
