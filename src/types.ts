import type { EditorDirtyIntent, EditorLocalCandidate } from "../core/editor-latch";
import type { VaultEventIntent } from "../core/vault-event";
import type { SafeApplyJournal } from "../core/safe-apply";
import type { RepositoryLocator } from "../core/locator";
import type { WriterFrontiers } from "../core/commit-frontier";
import type { CommitFrontierAnchor } from "../core/commit-frontier";
import type { ConfigProfile } from "../core/types";
import type { PersistedLocalConcurrentRecord } from "../core/local-concurrent-resolution";
import type { DurableOutboxEntry, DurablePublishedReconcile } from "../core/durable-outbox";
import type { RecoveryRecord } from "../core/recovery-record";
import type { OperationalStatus } from "../core/operational-status";
import type { PersistedConfigSyncState } from "./config-center-types";
import type { RemoteVaultConflictCandidate } from "../core/remote-vault-conflict";
import type { VerifiedRegisterObservation } from "../core/remote-merge-state";

export interface S3SyncSettings {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  forcePathStyle: boolean;
  autoSync: boolean;
  ignoredPatterns: string;
  configProfile: ConfigProfile;
}

export interface LocalFileState {
  hash: string;
  size: number;
  updatedAt: string;
}

export interface ConflictRecord {
  id: string;
  path: string;
  baseHash: string | null;
  localHash: string | null;
  remoteDisposition: "resolved" | "concurrent";
  remoteHeads: string[];
  remoteCandidates: RemoteVaultConflictCandidate[];
  detectedAt: string;
  resolved: boolean;
}

export interface S3SyncData {
  files: Record<string, LocalFileState>;
  conflicts: Record<string, ConflictRecord>;
  v1DirtyIntents: Record<string, EditorDirtyIntent>;
  v1ProjectedHeads: Record<string, string[]>;
  v1VaultEvents: VaultEventIntent[];
  v1VaultGenerations: Record<string, number>;
  v1RecoveryCandidates: Record<string, EditorLocalCandidate[]>;
  v1ApplyJournals: SafeApplyJournal[];
  v1SparseSeenCommits: Record<string, CommitFrontierAnchor>;
  v1ObservedRegisters: Record<string, VerifiedRegisterObservation>;
  v1PendingApply: Record<string, { targetHeads: string[]; targetValueHash: string | null }>;
  v1LocalConcurrentRecords: Record<string, PersistedLocalConcurrentRecord>;
  v1PublishedReconciles: DurablePublishedReconcile[];
  v1DurableOutbox: DurableOutboxEntry[];
  v1RecoveryRecords: Record<string, RecoveryRecord>;
  v1OperationalStatus: OperationalStatus;
  v1ConfigSync: PersistedConfigSyncState;
  v1?: {
    locator: RepositoryLocator;
    repositoryId: string;
    descriptorHash: string;
    repositoryFingerprint: string;
    writerFrontiers: WriterFrontiers;
    writerId: string;
    nextSequence: string;
    previousCommitHash: string | null;
    configDir: string;
    historicalConfigDirs: string[];
  };
}
