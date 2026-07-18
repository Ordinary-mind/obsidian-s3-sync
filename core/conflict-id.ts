import { sha256Hex } from "../protocol/hash";
import { canonicalizeProtocolJson } from "../protocol/json";
import { validateRemoteVaultPath } from "./path";
import { parseVersionId } from "./version-id";

export type ConflictChannel = "vault" | "config";

export interface ConflictIdentity {
  protocol: 1;
  repositoryId: string;
  channel: ConflictChannel;
  logicalKeys: string[];
  heads: string[];
}

export function canonicalConflictIdentity(
  repositoryId: string,
  channel: ConflictChannel,
  logicalKeys: readonly string[],
  heads: readonly string[],
): ConflictIdentity {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(repositoryId)) {
    throw new Error("conflict identity repositoryId is invalid");
  }
  if (channel !== "vault" && channel !== "config") throw new Error("conflict identity channel is invalid");
  const canonicalKeys = sortUtf8([...new Set(logicalKeys)]);
  const canonicalHeads = sortUtf8([...new Set(heads)]);
  if (canonicalKeys.length === 0 || canonicalHeads.length === 0) throw new Error("conflict identity cannot be empty");
  for (const logicalKey of canonicalKeys) validateLogicalKey(channel, logicalKey);
  for (const head of canonicalHeads) parseVersionId(head);
  return {
    protocol: 1,
    repositoryId,
    channel,
    logicalKeys: canonicalKeys,
    heads: canonicalHeads,
  };
}

export function conflictId(repositoryId: string, channel: ConflictChannel, logicalKeys: readonly string[], heads: readonly string[]): string {
  const source = canonicalizeProtocolJson(canonicalConflictIdentity(repositoryId, channel, logicalKeys, heads));
  return sha256Hex(new TextEncoder().encode(source));
}

export function vaultConflictId(repositoryId: string, logicalPaths: readonly string[], heads: readonly string[]): string {
  return conflictId(repositoryId, "vault", logicalPaths.map((path) => conflictLogicalKey("vault", path)), heads);
}

export function conflictLogicalKey(channel: ConflictChannel, logicalPath: string): string {
  if (channel === "config") {
    if (logicalPath !== "portable") throw new Error("config conflict logical path is invalid");
    return "config:portable";
  }
  if (channel !== "vault") throw new Error("conflict identity channel is invalid");
  return `vault:${validateRemoteVaultPath(logicalPath)}`;
}

function validateLogicalKey(channel: ConflictChannel, logicalKey: string): void {
  if (channel === "config") {
    if (logicalKey !== "config:portable") throw new Error("config conflict logical key is invalid");
    return;
  }
  if (!logicalKey.startsWith("vault:")) throw new Error("Vault conflict logical key is invalid");
  const path = logicalKey.slice("vault:".length);
  if (conflictLogicalKey("vault", path) !== logicalKey) throw new Error("Vault conflict logical key is invalid");
}

function sortUtf8(values: string[]): string[] {
  const encoder = new TextEncoder();
  return values.sort((left, right) => {
    const leftBytes = encoder.encode(left);
    const rightBytes = encoder.encode(right);
    const length = Math.min(leftBytes.length, rightBytes.length);
    for (let index = 0; index < length; index += 1) {
      if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
    }
    return leftBytes.length - rightBytes.length;
  });
}
