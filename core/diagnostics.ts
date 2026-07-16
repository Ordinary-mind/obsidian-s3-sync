export type SyncDiagnosticCategory =
  | "authentication"
  | "network"
  | "rate-limit"
  | "integrity"
  | "repository-identity"
  | "local-path"
  | "conflict"
  | "cancelled"
  | "internal";

export class DiagnosticError extends Error {
  readonly kind = "diagnostic";

  constructor(
    readonly code: string,
    readonly category: SyncDiagnosticCategory,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DiagnosticError";
  }
}

export function diagnosticCategory(error: unknown): SyncDiagnosticCategory {
  const value = isRecord(error) ? error : {};
  const details = isRecord(value.details) ? value.details : {};
  const metadata = isRecord(value.$metadata) ? value.$metadata : {};
  const status = firstNumber(value.status, value.statusCode, details.status, metadata.httpStatusCode);

  if (value.kind === "diagnostic" && isDiagnosticCategory(value.category)) return value.category;
  if (value.kind === "auth") return "authentication";
  if (value.kind === "throttled") return "rate-limit";
  if (value.kind === "integrity") return "integrity";
  if (value.kind === "temporary" || value.kind === "not-found") return "network";
  if (value.kind === "cancelled" || value.name === "AbortError") return "cancelled";
  if (value.kind === "connection-configuration") {
    return value.field === "access-key-id" || value.field === "secret-access-key"
      ? "authentication"
      : "repository-identity";
  }
  if (value.kind === "sync-preflight") return preflightCategory(value.blocker);

  const code = typeof value.code === "string" ? value.code.toUpperCase() : "";
  if (["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EISDIR", "ENOSPC", "EROFS", "EEXIST"].includes(code)) {
    return "local-path";
  }
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate-limit";
  if (typeof status === "number") return "network";
  return "internal";
}

export function isDiagnosticCategory(value: unknown): value is SyncDiagnosticCategory {
  return typeof value === "string" && [
    "authentication",
    "network",
    "rate-limit",
    "integrity",
    "repository-identity",
    "local-path",
    "conflict",
    "cancelled",
    "internal",
  ].includes(value);
}

function preflightCategory(blocker: unknown): SyncDiagnosticCategory {
  return "local-path";
}

function firstNumber(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
