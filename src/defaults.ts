import type { S3SyncData, S3SyncSettings } from "./types";
import { randomId } from "./utils";

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
  debounceSeconds: 10,
  ignoredPatterns: [
    ".trash/**",
    ".obsidian/plugins/obsidian-s3-sync/**",
    ".obsidian/workspace.json",
    ".obsidian/workspace-mobile.json",
  ].join("\n"),
};

export function createDefaultData(): S3SyncData {
  return {
    deviceId: randomId("device"),
    files: {},
    pendingDeletes: {},
    forceUploads: {},
    conflicts: {},
  };
}
