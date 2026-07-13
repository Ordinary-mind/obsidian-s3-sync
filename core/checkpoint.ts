import type { WriterFrontiers } from "./commit-frontier";

export interface RepositoryCheckpoint {
  schemaVersion: 1;
  repositoryId: string;
  descriptorHash: string;
  writerFrontiers: WriterFrontiers;
  stateHash: string;
  createdAt: number;
}

export interface CheckpointVerification {
  verifyDescriptor(repositoryId: string, descriptorHash: string): Promise<void>;
  verifyWriterFrontiers(repositoryId: string, descriptorHash: string, frontiers: WriterFrontiers): Promise<void>;
  verifyStateHash(checkpoint: RepositoryCheckpoint): Promise<boolean>;
}

export async function verifyCheckpointBeforeUse(
  checkpoint: RepositoryCheckpoint,
  verification: CheckpointVerification,
): Promise<"usable" | "full-history-required"> {
  try {
    await verification.verifyDescriptor(checkpoint.repositoryId, checkpoint.descriptorHash);
    await verification.verifyWriterFrontiers(checkpoint.repositoryId, checkpoint.descriptorHash, checkpoint.writerFrontiers);
    if (!(await verification.verifyStateHash(checkpoint))) return "full-history-required";
    return "usable";
  } catch {
    return "full-history-required";
  }
}

export const correctnessNeutralRemoteCaches = ["checkpoint", "latest", "device-head"] as const;
