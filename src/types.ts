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
  detectedAt: string;
  resolved: boolean;
}

export interface S3SyncData {
  deviceId: string;
  lastSyncedVersion: number;
  files: Record<string, LocalFileState>;
  conflicts: Record<string, ConflictRecord>;
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
