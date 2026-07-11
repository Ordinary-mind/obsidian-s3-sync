const namespace = ".obsidian-s3-sync/v1/repositories";

export function protocolRoot(prefix: string, repositoryId: string): string {
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, "");
  const parts = [normalizedPrefix, namespace, repositoryId].filter(Boolean);
  return parts.join("/");
}

export function descriptorKey(prefix: string, repositoryId: string): string {
  return `${protocolRoot(prefix, repositoryId)}/format.json`;
}

export function blobKey(prefix: string, repositoryId: string, hash: string): string {
  return `${protocolRoot(prefix, repositoryId)}/blobs/sha256/${hash.slice(0, 2)}/${hash}`;
}

export function configTreeKey(prefix: string, repositoryId: string, hash: string): string {
  return `${protocolRoot(prefix, repositoryId)}/config-trees/sha256/${hash.slice(0, 2)}/${hash}.json`;
}

export function changeChunkKey(prefix: string, repositoryId: string, hash: string): string {
  return `${protocolRoot(prefix, repositoryId)}/changes/sha256/${hash.slice(0, 2)}/${hash}.json`;
}

export function commitKey(
  prefix: string,
  repositoryId: string,
  writerId: string,
  sequence: string,
  hash: string,
): string {
  return `${protocolRoot(prefix, repositoryId)}/commits/${writerId}/${sequence}-${hash}.json`;
}
