import { sha256Hex } from "../protocol/hash";
import type { SyncDiagnosticCategory } from "./diagnostics";

export interface DiagnosticEvent {
  at: number;
  category: SyncDiagnosticCategory;
  stage: string;
  message: string;
  path?: string;
  requestId?: string;
  retryAttempt?: number;
}

export interface DiagnosticBundle {
  schemaVersion: 1;
  generatedAt: number;
  repositoryId?: string;
  normalizedPrefix?: string;
  status: Record<string, unknown>;
  events: Array<Omit<DiagnosticEvent, "path"> & { pathHash?: string }>;
}

export function buildRedactedDiagnosticBundle(input: {
  generatedAt: number;
  repositoryId?: string;
  normalizedPrefix?: string;
  status: Record<string, unknown>;
  events: readonly DiagnosticEvent[];
  pathSalt: string;
  sensitiveValues?: readonly string[];
}): DiagnosticBundle {
  if (input.pathSalt.length === 0) throw new Error("diagnostic path salt is required");
  const sensitive = (input.sensitiveValues ?? []).filter((value) => value.length > 0);
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    ...(input.repositoryId ? { repositoryId: input.repositoryId } : {}),
    ...(input.normalizedPrefix !== undefined ? { normalizedPrefix: redactPrefix(input.normalizedPrefix, input.pathSalt) } : {}),
    status: redactRecord(input.status, sensitive, input.pathSalt),
    events: input.events.map((event) => ({
      at: event.at,
      category: event.category,
      stage: redactText(event.stage, sensitive),
      message: redactText(event.message, sensitive),
      ...(event.path ? { pathHash: hashPrivateValue(event.path, input.pathSalt) } : {}),
      ...(event.requestId ? { requestId: redactText(event.requestId, sensitive) } : {}),
      ...(event.retryAttempt !== undefined ? { retryAttempt: event.retryAttempt } : {}),
    })),
  };
}

export function hashPrivateValue(value: string, salt: string): string {
  return sha256Hex(new TextEncoder().encode(`${salt}\u0000${value}`));
}

export function redactEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.origin;
  } catch {
    return "[invalid-endpoint-redacted]";
  }
}

function redactRecord(value: Record<string, unknown>, sensitive: readonly string[], pathSalt: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isSensitiveKey(key)) { result[key] = "[redacted]"; continue; }
    if (isSingularPrivateLocationKey(key)) {
      result[`${key}Hash`] = typeof nested === "string" ? hashPrivateValue(nested, pathSalt) : "[redacted]";
      continue;
    }
    if (isPrivateLocationCollectionKey(key)) {
      result[key] = Array.isArray(nested)
        ? nested.map((item) => typeof item === "string" ? hashPrivateValue(item, pathSalt) : "[redacted]")
        : "[redacted]";
      continue;
    }
    result[key] = redactValue(nested, sensitive, pathSalt);
  }
  return result;
}

function redactValue(value: unknown, sensitive: readonly string[], pathSalt: string): unknown {
  if (typeof value === "string") return redactText(value, sensitive);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, sensitive, pathSalt));
  if (isRecord(value)) return redactRecord(value, sensitive, pathSalt);
  return value;
}

function redactText(value: string, sensitive: readonly string[]): string {
  let result = value
    .replace(/AKIA[0-9A-Z]{16}/g, "[access-key-redacted]")
    .replace(/(secret|password|token|credential)(\s*[=:]\s*)[^\s,;]+/gi, "$1$2[redacted]");
  for (const secret of sensitive) result = result.split(secret).join("[redacted]");
  return result;
}

function redactPrefix(prefix: string, salt: string): string {
  return prefix.length === 0 ? "" : `sha256:${hashPrivateValue(prefix, salt)}`;
}

function isSensitiveKey(key: string): boolean {
  return /(secret|password|token|credential|access.?key|body|bytes|content|data\.json)/i.test(key);
}

function isSingularPrivateLocationKey(key: string): boolean {
  return /^(?:path|recoveryLocation|normalizedPrefix|prefix)$/i.test(key);
}

function isPrivateLocationCollectionKey(key: string): boolean {
  return /^(?:paths|missingClosure)$/i.test(key);
}

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
