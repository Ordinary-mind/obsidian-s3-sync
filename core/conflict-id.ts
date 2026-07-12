import { createHash } from "node:crypto";

export function conflictId(repositoryId: string, channel: string, logicalKeys: readonly string[], heads: readonly string[]): string {
  const source = JSON.stringify({ repositoryId, channel, logicalKeys: [...new Set(logicalKeys)].sort(), heads: [...new Set(heads)].sort() });
  return createHash("sha256").update(source, "utf8").digest("hex");
}
