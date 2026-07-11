const hashPattern = /^[0-9a-f]{64}$/;
const indexPattern = /^(0|[1-9][0-9]*)$/;

export interface VersionIdParts {
  commitHash: string;
  chunkIndex: number;
  mutationIndex: number;
}

export class VersionIdError extends Error {
  constructor(readonly code: "malformed" | "index-out-of-range", message: string) {
    super(message);
    this.name = "VersionIdError";
  }
}

export function createVersionId(commitHash: string, chunkIndex: number, mutationIndex: number): string {
  assertHash(commitHash);
  assertIndex(chunkIndex);
  assertIndex(mutationIndex);
  return `${commitHash}:${chunkIndex}:${mutationIndex}`;
}

export function parseVersionId(versionId: string): VersionIdParts {
  const match = /^([0-9a-f]{64}):(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.exec(versionId);
  if (!match) throw new VersionIdError("malformed", "Version ID must be hash:chunkIndex:mutationIndex");
  const [, commitHash, chunkIndexText, mutationIndexText] = match;
  const chunkIndex = Number(chunkIndexText);
  const mutationIndex = Number(mutationIndexText);
  if (!Number.isSafeInteger(chunkIndex) || !Number.isSafeInteger(mutationIndex)) {
    throw new VersionIdError("index-out-of-range", "Version ID index exceeds safe integer range");
  }
  return { commitHash, chunkIndex, mutationIndex };
}

function assertHash(hash: string): void {
  if (!hashPattern.test(hash)) throw new VersionIdError("malformed", "commit hash must be lowercase SHA-256");
}

function assertIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || !indexPattern.test(String(index))) {
    throw new VersionIdError("index-out-of-range", "Version ID index must be a non-negative safe integer");
  }
}
