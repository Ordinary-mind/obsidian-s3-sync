export function remoteConflictCopyPath(conflictId: string, blobHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(conflictId) || !/^[0-9a-f]{64}$/.test(blobHash)) {
    throw new Error("conflict and Blob IDs must be SHA-256");
  }
  return `.s3-sync-conflicts/${conflictId}/remote-${blobHash}`;
}
