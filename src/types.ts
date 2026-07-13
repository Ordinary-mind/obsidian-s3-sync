import type { EditorDirtyIntent, EditorLocalCandidate } from "../core/editor-latch";
import type { VaultEventIntent } from "../core/vault-event";
import type { ApplyJournal } from "../core/apply-journal";

export interface S3SyncSettings {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  forcePathStyle: boolean;
  autoSync: boolean;
  syncOnStartup: boolean;
  debounceSeconds: number;
  ignoredPatterns: string;
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
  remoteHash: string | null;
  remoteVersion: number;
  localDeviceId?: string;
  remoteUpdatedByDevice?: string;
  v1RemoteHeads?: string[];
  detectedAt: string;
  resolved: boolean;
}

export interface S3SyncData {
  deviceId: string;
  lastSyncedVersion: number;
  files: Record<string, LocalFileState>;
  conflicts: Record<string, ConflictRecord>;
  v1DirtyIntents: Record<string, EditorDirtyIntent>;
  v1ProjectedHeads: Record<string, string[]>;
  v1VaultEvents: VaultEventIntent[];
  v1VaultGenerations: Record<string, number>;
  v1RecoveryCandidates: Record<string, EditorLocalCandidate[]>;
  v1ApplyJournals: ApplyJournal[];
  v1?: {
    prefix: string;
    repositoryId: string;
    descriptorHash: string;
    writerId: string;
    nextSequence: string;
    previousCommitHash: string | null;
  };
}

export interface RemoteManifest {
  version: number;
  updatedAt: string;
  files: Record<string, RemoteManifestFile>;
}

export interface RemoteManifestFile {
  hash: string;
  size: number;
  updatedAt: string;
  updatedByDevice?: string;
}

export interface FileContent {
  hash: string;
  size: number;
  data: ArrayBuffer;
}

export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  deleted: number;
  conflicts: number;
  skipped: number;
}
