import { sha256Hex } from "../protocol/hash";
import { canonicalizeProtocolJson } from "../protocol/json";

export function conflictId(repositoryId: string, channel: string, logicalKeys: readonly string[], heads: readonly string[]): string {
  const source = canonicalizeProtocolJson({
    repositoryId,
    channel,
    logicalKeys: sortUtf8([...new Set(logicalKeys)]),
    heads: sortUtf8([...new Set(heads)]),
  });
  return sha256Hex(new TextEncoder().encode(source));
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
