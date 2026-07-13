import type { S3SyncData, S3SyncSettings } from "./types";
import { randomId } from "./utils";
import { createDefaultConfigProfile } from "../core/config-profile";

export const DEFAULT_SETTINGS: S3SyncSettings = {
  endpoint: "",
  region: "us-east-1",
  bucket: "",
  accessKeyId: "",
  secretAccessKey: "",
  prefix: "",
  forcePathStyle: true,
  autoSync: false,
  syncOnStartup: false,
  syncOnEvents: true,
  remotePolling: false,
  pollIntervalMinutes: 15,
  debounceSeconds: 10,
  ignoredPatterns: [
    ".trash/**",
    ".s3-sync/**",
    ".obsidian/plugins/obsidian-s3-sync/**",
    ".obsidian/workspace.json",
    ".obsidian/workspace-mobile.json",
  ].join("\n"),
  configSyncEnabled: false,
  configProfile: createDefaultConfigProfile("1.7.7"),
};

export function createDefaultData(): S3SyncData {
  return {
    deviceId: randomId("device"),
    lastSyncedVersion: 0,
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
    v1ReattachRequired: false,
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
      recoveryRequired: false,
      repositoryIdentityValid: true,
    },
  };
}
