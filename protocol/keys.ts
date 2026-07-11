import { utf8ByteLength } from "./limits";
import { normalizeNfc151 } from "./unicode";

const namespace = ".obsidian-s3-sync/v1/repositories";

export class ProtocolKeyError extends Error {
  constructor(
    readonly code: "prefix-invalid" | "key-too-long" | "key-body-hash-mismatch" | "commit-key-mismatch",
    message: string,
  ) {
    super(message);
    this.name = "ProtocolKeyError";
  }
}

export function assertContentAddressedKey(key: string, hash: string, extension = ""): void {
  const expectedSuffix = `/${hash.slice(0, 2)}/${hash}${extension}`;
  if (!key.endsWith(expectedSuffix)) {
    throw new ProtocolKeyError("key-body-hash-mismatch", "object key does not bind its content hash");
  }
}

export function assertCommitKey(key: string, writerId: string, sequence: string, hash: string): void {
  if (!key.endsWith(`/commits/${writerId}/${sequence}-${hash}.json`)) {
    throw new ProtocolKeyError("commit-key-mismatch", "commit key does not bind writer, sequence and hash");
  }
}

export function normalizeProtocolPrefix(prefix: string): string {
  const normalized = normalizeNfc151(prefix).replace(/^\/+|\/+$/g, "");
  if (normalized.length === 0) return normalized;
  if (
    /[\\\u0000-\u001f\u007f]/.test(normalized) ||
    normalized.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new ProtocolKeyError("prefix-invalid", "protocol prefix contains an invalid segment");
  }
  return normalized;
}

export function protocolRoot(prefix: string, repositoryId: string): string {
  const normalizedPrefix = normalizeProtocolPrefix(prefix);
  const parts = [normalizedPrefix, namespace, repositoryId].filter(Boolean);
  return parts.join("/");
}

export function assertS3KeyLength(key: string): void {
  if (utf8ByteLength(key) > 1024) {
    throw new ProtocolKeyError("key-too-long", "S3 object key exceeds 1,024 UTF-8 bytes");
  }
}

export function descriptorKey(prefix: string, repositoryId: string): string {
  return finishKey(`${protocolRoot(prefix, repositoryId)}/format.json`);
}

export function blobKey(prefix: string, repositoryId: string, hash: string): string {
  return finishKey(`${protocolRoot(prefix, repositoryId)}/blobs/sha256/${hash.slice(0, 2)}/${hash}`);
}

export function configTreeKey(prefix: string, repositoryId: string, hash: string): string {
  return finishKey(`${protocolRoot(prefix, repositoryId)}/config-trees/sha256/${hash.slice(0, 2)}/${hash}.json`);
}

export function changeChunkKey(prefix: string, repositoryId: string, hash: string): string {
  return finishKey(`${protocolRoot(prefix, repositoryId)}/changes/sha256/${hash.slice(0, 2)}/${hash}.json`);
}

export function commitKey(
  prefix: string,
  repositoryId: string,
  writerId: string,
  sequence: string,
  hash: string,
): string {
  return finishKey(`${protocolRoot(prefix, repositoryId)}/commits/${writerId}/${sequence}-${hash}.json`);
}

function finishKey(key: string): string {
  assertS3KeyLength(key);
  return key;
}
