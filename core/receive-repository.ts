import { parseAndValidateBoundCommitEnvelope, parseAndValidateKeyedCommitEnvelope } from "../protocol/validation";
import { registerVersionsFromEnvelope } from "./ingest";
import { InMemoryRepositoryCore } from "./repository";

export function receiveCommitBytes(repository: InMemoryRepositoryCore, repositoryId: string, descriptorHash: string, commitBytes: Uint8Array, chunkBytes: Uint8Array[]): string[] {
  const envelope = parseAndValidateBoundCommitEnvelope(repositoryId, descriptorHash, commitBytes, chunkBytes);
  const versions = registerVersionsFromEnvelope(envelope.commitHash, envelope.commit, envelope.chunks);
  for (const version of versions) repository.ingest(version);
  return versions.map((version) => version.versionId);
}

export function receiveKeyedCommitBytes(repository: InMemoryRepositoryCore, repositoryId: string, descriptorHash: string, commitKey: string, commitBytes: Uint8Array, chunkKeys: string[], chunkBytes: Uint8Array[]): string[] {
  const envelope = parseAndValidateKeyedCommitEnvelope(repositoryId, descriptorHash, commitKey, commitBytes, chunkKeys, chunkBytes);
  const versions = registerVersionsFromEnvelope(envelope.commitHash, envelope.commit, envelope.chunks);
  for (const version of versions) repository.ingest(version);
  return versions.map((version) => version.versionId);
}
