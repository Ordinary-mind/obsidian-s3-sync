import type { LocalPresence } from "./presence";

export type LocalNodeType = "file" | "missing" | "directory" | "symlink" | "reparse-point" | "unsafe" | "error" | "too-large" | "incompatible-path" | "scan-incomplete" | "out-of-scope" | "other";

export interface StableReadObservation { type: LocalNodeType; size?: number; hash?: string; }

export interface LocalNodeCapabilities {
  detectSymlink: boolean;
  detectReparsePoint: boolean;
  safeEnumeration: boolean;
}

export function isStableRead(first: StableReadObservation, second: StableReadObservation): boolean {
  return first.type === "file" && second.type === "file" && first.size === second.size && first.hash === second.hash;
}

export function classifyDeletionObservation(observation: StableReadObservation): "confirmed-absent" | "unknown" {
  return observation.type === "missing" ? "confirmed-absent" : "unknown";
}

export function classifyLocalPresence(observation: StableReadObservation): LocalPresence {
  if (observation.type === "file") return "present";
  if (observation.type === "missing") return "confirmed-absent";
  if (observation.type === "out-of-scope") return "out-of-scope";
  return "unknown";
}

export function unsupportedLocalNodeCapabilities(capabilities: LocalNodeCapabilities): string[] {
  const unsupported: string[] = [];
  if (!capabilities.detectSymlink) unsupported.push("symlink-detection");
  if (!capabilities.detectReparsePoint) unsupported.push("reparse-point-detection");
  if (!capabilities.safeEnumeration) unsupported.push("safe-enumeration");
  return unsupported;
}
