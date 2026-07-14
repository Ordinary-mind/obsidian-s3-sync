export type SyncDiagnosticCategory = "authentication" | "network" | "rate-limit" | "integrity" | "repository-identity" | "local-path" | "conflict";

export function diagnosticCategory(error: unknown): SyncDiagnosticCategory {
  const value = isRecord(error) ? error : {};
  const metadata = isRecord(value.$metadata) ? value.$metadata : {};
  const details = isRecord(value.details) ? value.details : {};
  const status = firstNumber(value.status, value.statusCode, metadata.httpStatusCode, details.status);
  const source = [value.code, value.name, value.kind, value.Code, value.message]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase();

  if (source.includes("integrity") || source.includes("hash-mismatch") || source.includes("checksum")
    || source.includes("tamper") || source.includes("corrupt") || source.includes("canonical json")
    || source.includes("protocol object") || source.includes("schema validation")) return "integrity";
  if (status === 401 || status === 403 || source.includes("accessdenied") || source.includes("auth")) return "authentication";
  if (status === 429 || source.includes("throttl") || source.includes("slowdown") || source.includes("rate-limit")) return "rate-limit";
  if (source.includes("repository") || source.includes("descriptor") || source.includes("reattach") || source.includes("frontier anchor")) return "repository-identity";
  if (source.includes("local-path") || source.includes("filesystem") || source.includes("no-clobber")
    || source.includes("path occupied") || source.includes("active file") || source.includes("stable capture")
    || source.includes("local causal") || source.includes("editor generation") || source.includes("regular file")
    || source.includes("config path") || source.includes("safely inspectable")) return "local-path";
  if (source.includes("conflict") || source.includes("concurrent") || source.includes("reconcil")) return "conflict";
  return "network";
}

function firstNumber(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
