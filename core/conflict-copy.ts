import { sha256Hex } from "../protocol/hash";

export function remoteConflictCopyPath(conflictId: string, blobHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(conflictId) || !/^[0-9a-f]{64}$/.test(blobHash)) {
    throw new Error("conflict and Blob IDs must be SHA-256");
  }
  return `.s3-sync-conflicts/${conflictId}/remote-${blobHash}`;
}

export function conflictVersionCopyPath(conflictId: string, versionId: string, logicalPath: string): string {
  if (!/^[0-9a-f]{64}$/.test(conflictId) || versionId.length === 0) throw new Error("conflict ID or Version ID is invalid");
  const safeId = sha256Hex(new TextEncoder().encode(versionId));
  return `.s3-sync-conflicts/${conflictId}/put-${safeId}${safePreviewExtension(logicalPath)}`;
}

export function conflictCopyContentMatches(
  bytes: Uint8Array,
  expected: { hash: string; size: number },
): boolean {
  return bytes.byteLength === expected.size && sha256Hex(bytes) === expected.hash;
}

export function conflictMetadataPath(conflictId: string): string {
  if (!/^[0-9a-f]{64}$/.test(conflictId)) throw new Error("conflict ID must be SHA-256");
  return `.s3-sync-conflicts/${conflictId}/metadata.json`;
}

function safePreviewExtension(logicalPath: string): string {
  const name = logicalPath.slice(logicalPath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  const extension = name.slice(dot);
  return /^\.[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/.test(extension) ? extension : "";
}
