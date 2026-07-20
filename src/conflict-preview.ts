import { DiagnosticError } from "../core/diagnostics";

export interface ConflictPreviewLimits {
  maximumBytes: number;
  maximumLines: number;
}

export const defaultConflictPreviewLimits: ConflictPreviewLimits = {
  maximumBytes: 1024 * 1024,
  maximumLines: 20_000,
};

export type ConflictPreviewUnavailableReason = "binary" | "invalid-utf8" | "too-large" | "too-many-lines";

export type ConflictPreviewSide =
  | { kind: "text"; text: string; size: number; lines: number }
  | { kind: "missing"; size: 0 }
  | { kind: "unavailable"; reason: ConflictPreviewUnavailableReason; size: number; lines?: number };

export interface ConflictTextComparison {
  local: ConflictPreviewSide;
  remote: ConflictPreviewSide;
}

export function previewConflictBytes(
  bytes: Uint8Array,
  limits: ConflictPreviewLimits = defaultConflictPreviewLimits,
): ConflictPreviewSide {
  validateLimits(limits);
  if (bytes.byteLength > limits.maximumBytes) {
    return { kind: "unavailable", reason: "too-large", size: bytes.byteLength };
  }
  if (containsBinaryControl(bytes)) {
    return { kind: "unavailable", reason: "binary", size: bytes.byteLength };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { kind: "unavailable", reason: "invalid-utf8", size: bytes.byteLength };
  }
  const lines = text.length === 0 ? 0 : countLines(text);
  if (lines > limits.maximumLines) {
    return { kind: "unavailable", reason: "too-many-lines", size: bytes.byteLength, lines };
  }
  return { kind: "text", text, size: bytes.byteLength, lines };
}

export function missingConflictPreview(): ConflictPreviewSide {
  return { kind: "missing", size: 0 };
}

export function oversizedConflictPreview(size: number): ConflictPreviewSide {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new DiagnosticError("CONFLICT_PREVIEW_SIZE_INVALID", "internal", "conflict preview size is invalid");
  }
  return { kind: "unavailable", reason: "too-large", size };
}

export function mayLoadConflictPreview(size: number, limits: ConflictPreviewLimits = defaultConflictPreviewLimits): boolean {
  validateLimits(limits);
  return Number.isSafeInteger(size) && size >= 0 && size <= limits.maximumBytes;
}

function containsBinaryControl(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte === 0) return true;
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) return true;
  }
  return false;
}

function countLines(text: string): number {
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

function validateLimits(limits: ConflictPreviewLimits): void {
  if (!Number.isSafeInteger(limits.maximumBytes) || limits.maximumBytes < 1
    || !Number.isSafeInteger(limits.maximumLines) || limits.maximumLines < 1) {
    throw new DiagnosticError("CONFLICT_PREVIEW_LIMITS_INVALID", "internal", "conflict preview limits are invalid");
  }
}
