export const protocolLimits = {
  formatBytes: 4 * 1024,
  commitBytes: 256 * 1024,
  changeChunkBytes: 4 * 1024 * 1024,
  configTreeBytes: 16 * 1024 * 1024,
  mutationParents: 1024,
  chunkMutations: 4096,
  commitChunks: 1024,
  configTreeItems: 100000,
  jsonDepth: 16,
  jsonArrayItems: 100000,
  jsonStringUtf8Bytes: 4 * 1024,
  logicalPathUtf8Bytes: 1024,
  blobBytes: 5_000_000_000,
  maxSequence: 18_446_744_073_709_551_615n,
} as const;

export type StructureLimitViolation =
  | "json-depth-exceeded"
  | "json-array-items-exceeded"
  | "json-string-bytes-exceeded"
  | "json-number-not-safe-integer";

export type CollectionLimitName = "parents" | "chunk-mutations" | "commit-chunks" | "config-tree-items";

const encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function validateParsedJsonLimits(value: unknown, depth = 1): StructureLimitViolation[] {
  if (depth > protocolLimits.jsonDepth) return ["json-depth-exceeded"];
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && !Object.is(value, -0)
      ? []
      : ["json-number-not-safe-integer"];
  }
  if (typeof value === "string") {
    return utf8ByteLength(value) > protocolLimits.jsonStringUtf8Bytes
      ? ["json-string-bytes-exceeded"]
      : [];
  }
  if (Array.isArray(value)) {
    if (value.length > protocolLimits.jsonArrayItems) return ["json-array-items-exceeded"];
    return [...new Set(value.flatMap((item) => validateParsedJsonLimits(item, depth + 1)))];
  }
  if (value && typeof value === "object") {
    return [
      ...new Set(
        Object.entries(value).flatMap(([key, child]) => [
          ...validateParsedJsonLimits(key, depth),
          ...validateParsedJsonLimits(child, depth + 1),
        ]),
      ),
    ];
  }
  return [];
}

export function isValidSequence(sequence: string): boolean {
  return (
    /^[0-9]{20}$/.test(sequence) &&
    sequence !== "00000000000000000000" &&
    BigInt(sequence) <= protocolLimits.maxSequence
  );
}

export function isWithinCollectionLimit(name: CollectionLimitName, count: number): boolean {
  const limit = {
    parents: protocolLimits.mutationParents,
    "chunk-mutations": protocolLimits.chunkMutations,
    "commit-chunks": protocolLimits.commitChunks,
    "config-tree-items": protocolLimits.configTreeItems,
  }[name];
  return Number.isSafeInteger(count) && count >= 0 && count <= limit;
}

export function isWithinBlobLimit(size: number): boolean {
  return Number.isSafeInteger(size) && size >= 0 && size <= protocolLimits.blobBytes;
}
