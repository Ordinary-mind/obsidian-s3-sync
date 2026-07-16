import type { S3SyncData, S3SyncSettings } from "./types";
import { createDefaultConfigProfile } from "../core/config-profile";
import { createDefaultConfigSyncState } from "./config-center-types";

export const DEFAULT_SETTINGS: S3SyncSettings = {
  endpoint: "",
  region: "us-east-1",
  bucket: "",
  accessKeyId: "",
  secretAccessKey: "",
  prefix: "",
  forcePathStyle: true,
  autoSync: false,
  ignoredPatterns: ".trash/**",
  configProfile: createDefaultConfigProfile("1.7.7"),
};

export function createDefaultData(): S3SyncData {
  return {
    files: {},
    conflicts: {},
    v1DirtyIntents: {},
    v1ProjectedHeads: {},
    v1VaultEvents: [],
    v1VaultGenerations: {},
    v1RecoveryCandidates: {},
    v1ApplyJournals: [],
    v1SparseSeenCommits: {},
    v1ObservedRegisters: {},
    v1PendingApply: {},
    v1LocalConcurrentRecords: {},
    v1PublishedReconciles: [],
    v1DurableOutbox: [],
    v1RecoveryRecords: {},
    v1OperationalStatus: {
      phase: "idle",
      pendingApply: 0,
      outbox: 0,
      localConcurrentRecords: 0,
      recoveryFiles: 0,
      postCaptureEdits: 0,
      commitGaps: 0,
      conflicts: 0,
      retryAttempt: 0,
      decisions: [],
      audit: { state: "never", completedObjects: 0, totalObjects: 0, missingClosure: [], resumable: false },
      recoveryBlockers: [],
      repositoryIdentityValid: true,
    },
    v1ConfigSync: createDefaultConfigSyncState(),
  };
}
