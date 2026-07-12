export type SyncDiagnosticCategory = "authentication" | "network" | "rate-limit" | "integrity" | "repository-identity" | "local-path" | "conflict";

export function diagnosticCategory(error: { code?: string; status?: number }): SyncDiagnosticCategory {
  if (error.code?.startsWith("integrity") || error.code?.includes("hash")) return "integrity";
  if (error.status === 401 || error.status === 403) return "authentication";
  if (error.status === 429) return "rate-limit";
  if (error.code?.includes("repository") || error.code?.includes("descriptor")) return "repository-identity";
  if (error.code?.includes("path")) return "local-path";
  if (error.code?.includes("conflict")) return "conflict";
  return "network";
}
