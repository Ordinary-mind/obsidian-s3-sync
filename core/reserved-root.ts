import { canonicalizeProtocolJson, parseCanonicalProtocolJson } from "../protocol/json";

const encoder = new TextEncoder();
const metadataByteLimit = 4 * 1024;

export type ReservedRootKind = "repository-state" | "vault-conflicts";

export type ReservedRootMetadata =
  | { schemaVersion: 1; owner: "obsidian-s3-sync"; rootKind: "repository-state"; repositoryId: string }
  | { schemaVersion: 1; owner: "obsidian-s3-sync"; rootKind: "vault-conflicts" };

export type ReservedRootObservation =
  | { type: "missing" }
  | { type: "directory"; metadata?: Uint8Array }
  | { type: "file" | "symlink" | "reparse-point" | "unknown" };

export type ReservedRootAssessment =
  | { decision: "create" | "use" }
  | { decision: "refuse"; reason: "not-directory" | "unsafe-node" | "metadata-missing" | "metadata-invalid" | "metadata-mismatch" };

export function createReservedRootMetadata(rootKind: "repository-state", repositoryId: string): ReservedRootMetadata;
export function createReservedRootMetadata(rootKind: "vault-conflicts"): ReservedRootMetadata;
export function createReservedRootMetadata(rootKind: ReservedRootKind, repositoryId?: string): ReservedRootMetadata {
  if (rootKind === "repository-state") {
    assertRepositoryId(repositoryId);
    return { schemaVersion: 1, owner: "obsidian-s3-sync", rootKind, repositoryId };
  }
  return { schemaVersion: 1, owner: "obsidian-s3-sync", rootKind };
}

export function encodeReservedRootMetadata(metadata: ReservedRootMetadata): Uint8Array {
  return encoder.encode(canonicalizeProtocolJson(metadata));
}

export function parseReservedRootMetadata(bytes: Uint8Array): ReservedRootMetadata {
  const value = parseCanonicalProtocolJson(bytes, metadataByteLimit);
  const keys = Object.keys(value).sort();
  if (value.schemaVersion !== 1 || value.owner !== "obsidian-s3-sync") throw new Error("invalid reserved root owner metadata");
  if (value.rootKind === "repository-state") {
    if (keys.join(",") !== "owner,repositoryId,rootKind,schemaVersion" || typeof value.repositoryId !== "string") {
      throw new Error("invalid repository state root metadata shape");
    }
    assertRepositoryId(value.repositoryId);
    return value as ReservedRootMetadata;
  }
  if (value.rootKind === "vault-conflicts" && keys.join(",") === "owner,rootKind,schemaVersion") {
    return value as ReservedRootMetadata;
  }
  throw new Error("invalid reserved root metadata shape");
}

export function assessReservedRoot(
  observation: ReservedRootObservation,
  expected: ReservedRootMetadata,
): ReservedRootAssessment {
  if (observation.type === "missing") return { decision: "create" };
  if (observation.type === "file") return { decision: "refuse", reason: "not-directory" };
  if (observation.type !== "directory") return { decision: "refuse", reason: "unsafe-node" };
  if (!observation.metadata) return { decision: "refuse", reason: "metadata-missing" };
  let actual: ReservedRootMetadata;
  try {
    actual = parseReservedRootMetadata(observation.metadata);
  } catch {
    return { decision: "refuse", reason: "metadata-invalid" };
  }
  return sameMetadata(actual, expected)
    ? { decision: "use" }
    : { decision: "refuse", reason: "metadata-mismatch" };
}

function sameMetadata(left: ReservedRootMetadata, right: ReservedRootMetadata): boolean {
  return left.rootKind === right.rootKind
    && (left.rootKind !== "repository-state"
      || (right.rootKind === "repository-state" && left.repositoryId === right.repositoryId));
}

function assertRepositoryId(repositoryId: string | undefined): asserts repositoryId is string {
  if (!repositoryId || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(repositoryId)) {
    throw new Error("invalid repositoryId in reserved root metadata");
  }
}
