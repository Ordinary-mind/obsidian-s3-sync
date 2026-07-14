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
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return encoder.encode(value).byteLength;
  }
  return value.length;
}

export function validateParsedJsonLimits(value: unknown, depth = 1): StructureLimitViolation[] {
  const violations = new Set<StructureLimitViolation>();
  collectParsedJsonLimitViolations(value, depth, violations);
  return [...violations];
}

function collectParsedJsonLimitViolations(
  value: unknown,
  depth: number,
  violations: Set<StructureLimitViolation>,
): void {
  if (depth > protocolLimits.jsonDepth) {
    violations.add("json-depth-exceeded");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      violations.add("json-number-not-safe-integer");
    }
    return;
  }
  if (typeof value === "string") {
    if (utf8ByteLength(value) > protocolLimits.jsonStringUtf8Bytes) {
      violations.add("json-string-bytes-exceeded");
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > protocolLimits.jsonArrayItems) {
      violations.add("json-array-items-exceeded");
      return;
    }
    for (const item of value) collectParsedJsonLimitViolations(item, depth + 1, violations);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      collectParsedJsonLimitViolations(key, depth, violations);
      collectParsedJsonLimitViolations(child, depth + 1, violations);
    }
  }
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
