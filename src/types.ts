export type RemoteOpType = "upsert" | "delete";

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
  lastSyncedHash: string | null;
  lastRemoteOpId: string | null;
  deleted: boolean;
  updatedAt: string;
}

export interface ConflictRecord {
  id: string;
  path: string;
  conflictPath: string;
  localHash: string | null;
  remoteHash: string | null;
  remoteOpId: string | null;
  detectedAt: string;
  resolved: boolean;
}

export interface S3SyncData {
  deviceId: string;
  files: Record<string, LocalFileState>;
  pendingDeletes: Record<string, PendingDelete>;
  forceUploads: Record<string, string>;
  conflicts: Record<string, ConflictRecord>;
}

export interface PendingDelete {
  path: string;
  baseHash: string | null;
  deletedAt: string;
}

export interface RemoteOp {
  opId: string;
  type: RemoteOpType;
  path: string;
  deviceId: string;
  baseHash: string | null;
  newHash: string | null;
  objectKey: string | null;
  size: number;
  createdAt: string;
}

export interface RemoteSnapshot {
  version: 1;
  createdAt: string;
  lastOpId: string | null;
  files: Record<string, RemoteFileRecord>;
}

export interface RemoteFileRecord {
  path: string;
  hash: string | null;
  objectKey: string | null;
  size: number;
  deleted: boolean;
  updatedAt: string;
  updatedByDevice: string;
  opId: string;
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
