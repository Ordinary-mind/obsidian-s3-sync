import { Notice, TFile, Vault, normalizePath } from "obsidian";
import type {
  ConflictRecord,
  FileContent,
  LocalFileState,
  RemoteManifest,
  S3SyncData,
  S3SyncSettings,
  SyncSummary,
} from "./types";
import { S3Remote } from "./s3-remote";
import {
  ensureParentFolder,
  isIgnored,
  nowIso,
  parseIgnorePatterns,
  randomId,
  resolveEffectivePrefix,
  sha256Hex,
} from "./utils";

type QueueAction = "upsert" | "delete";
type HashValue = string | null;

export interface SyncEngineOptions {
  vault: Vault;
  settings: S3SyncSettings;
  data: S3SyncData;
  saveData: () => Promise<void>;
}

interface LocalSnapshotEntry {
  hash: HashValue;
  size: number;
  data: ArrayBuffer | null;
}

interface RemoteChange {
  type: "upload" | "delete";
  path: string;
  content?: FileContent;
}

export class SyncEngine {
  private readonly vault: Vault;
  private readonly data: S3SyncData;
  private readonly saveData: () => Promise<void>;
  private readonly remote: S3Remote;
  private readonly ignoredPatterns: RegExp[];
  private readonly queue = new Map<string, QueueAction>();
  private readonly mutedPaths = new Set<string>();
  private syncRunning = false;

  constructor(options: SyncEngineOptions) {
    this.vault = options.vault;
    this.data = options.data;
    this.saveData = options.saveData;
    this.remote = new S3Remote({
      ...options.settings,
      prefix: resolveEffectivePrefix(options.settings.prefix, options.vault.getName()),
    });
    this.ignoredPatterns = parseIgnorePatterns(options.settings.ignoredPatterns);
  }

  queueUpsert(file: TFile): boolean {
    if (this.shouldSkip(file.path)) {
      return false;
    }
    this.queue.set(normalizePath(file.path), "upsert");
    return true;
  }

  queueDelete(path: string): boolean {
    const normalized = normalizePath(path);
    if (this.shouldSkip(normalized)) {
      return false;
    }
    this.queue.set(normalized, "delete");
    return true;
  }

  hasQueuedWork(): boolean {
    return this.queue.size > 0;
  }

  isMuted(path: string): boolean {
    return this.mutedPaths.has(normalizePath(path));
  }

  async testConnection(): Promise<void> {
    await this.remote.testConnection();
  }

  async syncQueued(): Promise<SyncSummary> {
    const paths = Array.from(this.queue.keys());
    this.queue.clear();
    return this.sync(paths);
  }

  async syncAllKnownFiles(): Promise<SyncSummary> {
    const paths = new Set((await this.listAllFiles(""))
      .filter((path) => !this.shouldSkip(path)));

    for (const path of Object.keys(this.data.files)) {
      const normalized = normalizePath(path);
      if (!this.shouldSkip(normalized)) {
        paths.add(normalized);
      }
    }

    return this.sync(Array.from(paths));
  }

  async rebuildRemoteFromLocal(): Promise<SyncSummary> {
    await this.remote.deletePrefix();
    this.queue.clear();
    this.data.files = {};
    this.data.conflicts = {};
    this.data.lastSyncedVersion = 0;

    const summary: SyncSummary = {
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      skipped: 0,
    };

    const manifest: RemoteManifest = {
      version: 1,
      updatedAt: nowIso(),
      files: {},
    };

    const paths = (await this.listAllFiles(""))
      .filter((path) => !this.shouldSkip(path));

    for (const path of paths) {
      const content = await this.readPathContent(path);
      await this.remote.uploadFile(path, content.data);
      manifest.files[path] = {
        hash: content.hash,
        size: content.size,
        updatedAt: nowIso(),
        updatedByDevice: this.data.deviceId,
      };
      this.markBase(path, content.hash, content.size);
      summary.uploaded += 1;
    }

    await this.remote.writeManifest(manifest);
    this.data.lastSyncedVersion = manifest.version;
    await this.saveData();
    return summary;
  }

  async resolveConflict(conflictId: string, mode: "local" | "remote"): Promise<void> {
    const conflict = this.data.conflicts[conflictId];
    if (!conflict || conflict.resolved) {
      return;
    }

    if (mode === "remote") {
      await this.acceptRemote(conflict);
    } else {
      await this.acceptLocal(conflict);
    }

    conflict.resolved = true;
    delete this.data.conflicts[conflictId];
    await this.saveData();
  }

  private async sync(paths: string[]): Promise<SyncSummary> {
    if (this.syncRunning) {
      throw new Error("已有同步任务正在运行");
    }

    this.remote.validate();
    this.syncRunning = true;

    const summary: SyncSummary = {
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      skipped: 0,
    };

    try {
      const manifest = await this.remote.readManifest();
      const local = await this.buildLocalSnapshot(paths);
      const remoteChanges: RemoteChange[] = [];

      for (const path of Object.keys(local)) {
        if (this.shouldSkip(path)) {
          summary.skipped += 1;
          continue;
        }

        await this.planPath(path, local[path], manifest, remoteChanges, summary);
      }

      if (remoteChanges.length > 0) {
        await this.commitRemoteChanges(manifest, remoteChanges, summary);
      }

      this.data.lastSyncedVersion = manifest.version;
      await this.saveData();
      return summary;
    } finally {
      this.syncRunning = false;
    }
  }

  private async planPath(
    path: string,
    local: LocalSnapshotEntry,
    manifest: RemoteManifest,
    remoteChanges: RemoteChange[],
    summary: SyncSummary,
  ): Promise<void> {
    const baseHash = this.data.files[path]?.hash ?? null;
    const localHash = local.hash;
    const remoteFile = manifest.files[path];
    const remoteHash = remoteFile?.hash ?? null;

    if (localHash === remoteHash) {
      this.markBase(path, localHash, local.size);
      summary.skipped += 1;
      return;
    }

    if (localHash === baseHash && remoteHash !== baseHash) {
      await this.applyRemote(path, remoteHash, manifest, summary);
      return;
    }

    if (remoteHash === baseHash && localHash !== baseHash) {
      if (localHash === null) {
        remoteChanges.push({ type: "delete", path });
      } else if (local.data) {
        remoteChanges.push({
          type: "upload",
          path,
          content: {
            hash: localHash,
            size: local.size,
            data: local.data,
          },
        });
      }
      return;
    }

    if (remoteFile?.updatedByDevice === this.data.deviceId) {
      if (localHash === null) {
        remoteChanges.push({ type: "delete", path });
      } else if (local.data) {
        remoteChanges.push({
          type: "upload",
          path,
          content: {
            hash: localHash,
            size: local.size,
            data: local.data,
          },
        });
      }
      return;
    }

    this.recordConflict(path, baseHash, localHash, remoteHash, manifest.version);
    summary.conflicts += 1;
  }

  private async applyRemote(
    path: string,
    remoteHash: HashValue,
    manifest: RemoteManifest,
    summary: SyncSummary,
  ): Promise<void> {
    if (remoteHash === null) {
      if (await this.vault.adapter.exists(path)) {
        this.mute(path);
        await this.vault.adapter.remove(path);
        summary.deleted += 1;
      }
      delete this.data.files[path];
      return;
    }

    const remoteData = await this.remote.downloadFile(path);
    await this.writeBinary(path, remoteData);
    this.markBase(path, remoteHash, manifest.files[path]?.size ?? remoteData.byteLength);
    summary.downloaded += 1;
  }

  private async commitRemoteChanges(
    manifest: RemoteManifest,
    changes: RemoteChange[],
    summary: SyncSummary,
  ): Promise<void> {
    const latest = await this.remote.readManifest();
    if (latest.version !== manifest.version) {
      throw new Error("远端版本已变化，请重新同步");
    }

    for (const change of changes) {
      if (change.type === "delete") {
      await this.remote.deleteFile(change.path);
      delete manifest.files[change.path];
      delete this.data.files[change.path];
      this.clearConflictsForPath(change.path);
      summary.deleted += 1;
      } else if (change.content) {
        await this.remote.uploadFile(change.path, change.content.data);
        manifest.files[change.path] = {
          hash: change.content.hash,
          size: change.content.size,
          updatedAt: nowIso(),
          updatedByDevice: this.data.deviceId,
        };
        this.markBase(change.path, change.content.hash, change.content.size);
        summary.uploaded += 1;
      }
    }

    manifest.version += 1;
    manifest.updatedAt = nowIso();
    await this.remote.writeManifest(manifest);
  }

  private async acceptRemote(conflict: ConflictRecord): Promise<void> {
    const manifest = await this.remote.readManifest();
    const remoteHash = manifest.files[conflict.path]?.hash ?? null;
    if (remoteHash !== conflict.remoteHash) {
      throw new Error("远端版本已变化，请重新同步后再解决冲突");
    }

    if (remoteHash === null) {
      if (await this.vault.adapter.exists(conflict.path)) {
        this.mute(conflict.path);
        await this.vault.adapter.remove(conflict.path);
      }
      delete this.data.files[conflict.path];
      this.data.lastSyncedVersion = manifest.version;
      return;
    }

    const remoteData = await this.remote.downloadFile(conflict.path);
    await this.writeBinary(conflict.path, remoteData);
    this.markBase(conflict.path, remoteHash, manifest.files[conflict.path]?.size ?? remoteData.byteLength);
    this.data.lastSyncedVersion = manifest.version;
  }

  private async acceptLocal(conflict: ConflictRecord): Promise<void> {
    const manifest = await this.remote.readManifest();
    const remoteHash = manifest.files[conflict.path]?.hash ?? null;
    if (remoteHash !== conflict.remoteHash) {
      throw new Error("远端版本已变化，请重新同步后再解决冲突");
    }

    const local = await this.readOptionalPathContent(conflict.path);
    if (local.hash !== conflict.localHash) {
      throw new Error("本地文件已变化，请重新同步后再解决冲突");
    }

    if (local.hash === null) {
      await this.remote.deleteFile(conflict.path);
      delete manifest.files[conflict.path];
      delete this.data.files[conflict.path];
      this.clearConflictsForPath(conflict.path);
    } else if (local.data) {
      await this.remote.uploadFile(conflict.path, local.data);
      manifest.files[conflict.path] = {
        hash: local.hash,
        size: local.size,
        updatedAt: nowIso(),
        updatedByDevice: this.data.deviceId,
      };
      this.markBase(conflict.path, local.hash, local.size);
    }

    manifest.version += 1;
    manifest.updatedAt = nowIso();
    await this.remote.writeManifest(manifest);
    this.data.lastSyncedVersion = manifest.version;
  }

  private recordConflict(
    path: string,
    baseHash: HashValue,
    localHash: HashValue,
    remoteHash: HashValue,
    remoteVersion: number,
  ): void {
    const existing = Object.values(this.data.conflicts).find((conflict) => (
      !conflict.resolved &&
      conflict.path === path &&
      conflict.localHash === localHash &&
      conflict.remoteHash === remoteHash
    ));
    if (existing) {
      return;
    }

    const id = randomId("conflict");
    this.data.conflicts[id] = {
      id,
      path,
      baseHash,
      localHash,
      remoteHash,
      remoteVersion,
      detectedAt: nowIso(),
      resolved: false,
    };
    new Notice(`S3 Sync 发现冲突：${path}`);
  }

  private async buildLocalSnapshot(paths: string[]): Promise<Record<string, LocalSnapshotEntry>> {
    const snapshot: Record<string, LocalSnapshotEntry> = {};
    for (const path of paths) {
      snapshot[normalizePath(path)] = await this.readOptionalPathContent(path);
    }
    return snapshot;
  }

  private async readOptionalPathContent(path: string): Promise<LocalSnapshotEntry> {
    const normalized = normalizePath(path);
    if (!(await this.vault.adapter.exists(normalized))) {
      return {
        hash: null,
        size: 0,
        data: null,
      };
    }

    const content = await this.readPathContent(normalized);
    return {
      hash: content.hash,
      size: content.size,
      data: content.data,
    };
  }

  private async readPathContent(path: string): Promise<FileContent> {
    const data = await this.vault.adapter.readBinary(normalizePath(path));
    const hash = await sha256Hex(data);
    return {
      hash,
      size: data.byteLength,
      data,
    };
  }

  private async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const normalized = normalizePath(path);
    await ensureParentFolder(this.vault, normalized);
    this.mute(normalized);
    await this.vault.adapter.writeBinary(normalized, data);
  }

  private markBase(path: string, hash: HashValue, size: number): void {
    const normalized = normalizePath(path);
    if (hash === null) {
      delete this.data.files[normalized];
      this.clearConflictsForPath(normalized);
      return;
    }

    const state: LocalFileState = {
      hash,
      size,
      updatedAt: nowIso(),
    };
    this.data.files[normalized] = state;
    this.clearConflictsForPath(normalized);
  }

  private clearConflictsForPath(path: string): void {
    const normalized = normalizePath(path);
    for (const [id, conflict] of Object.entries(this.data.conflicts)) {
      if (normalizePath(conflict.path) === normalized) {
        delete this.data.conflicts[id];
      }
    }
  }

  private async listAllFiles(folder: string): Promise<string[]> {
    const normalizedFolder = normalizePath(folder);
    const listed = await this.vault.adapter.list(normalizedFolder);
    const files = listed.files.map((file) => normalizePath(file));

    for (const childFolder of listed.folders) {
      files.push(...await this.listAllFiles(childFolder));
    }

    return files;
  }

  private mute(path: string): void {
    const normalized = normalizePath(path);
    this.mutedPaths.add(normalized);
    window.setTimeout(() => this.mutedPaths.delete(normalized), 3000);
  }

  private shouldSkip(path: string): boolean {
    return isIgnored(normalizePath(path), this.ignoredPatterns);
  }
}
