import { parseAndValidateBoundCommitEnvelope } from "../protocol/validation";
import { registerVersionsFromEnvelope } from "./ingest";
import { InMemoryRepositoryCore } from "./repository";

export function receiveCommitBytes(repository: InMemoryRepositoryCore, repositoryId: string, descriptorHash: string, commitBytes: Uint8Array, chunkBytes: Uint8Array[]): string[] {
  const envelope = parseAndValidateBoundCommitEnvelope(repositoryId, descriptorHash, commitBytes, chunkBytes);
  const versions = registerVersionsFromEnvelope(envelope.commitHash, envelope.commit, envelope.chunks);
  for (const version of versions) repository.ingest(version);
  return versions.map((version) => version.versionId);
}
