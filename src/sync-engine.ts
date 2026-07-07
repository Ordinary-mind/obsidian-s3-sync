import { Notice, TFile, Vault, normalizePath } from "obsidian";
import type {
  ConflictRecord,
  FileContent,
  LocalFileState,
  RemoteFileRecord,
  RemoteOp,
  RemoteSnapshot,
  S3SyncData,
  S3SyncSettings,
  SyncSummary,
} from "./types";
import { S3Remote } from "./s3-remote";
import {
  createConflictPath,
  getTFile,
  ensureParentFolder,
  isIgnored,
  nowIso,
  parseIgnorePatterns,
  randomId,
  resolveEffectivePrefix,
  sha256Hex,
} from "./utils";

type QueueAction = "upsert" | "delete";

export interface SyncEngineOptions {
  vault: Vault;
  settings: S3SyncSettings;
  data: S3SyncData;
  saveData: () => Promise<void>;
}

export class SyncEngine {
  private readonly vault: Vault;
  private readonly settings: S3SyncSettings;
  private readonly data: S3SyncData;
  private readonly saveData: () => Promise<void>;
  private readonly remote: S3Remote;
  private readonly ignoredPatterns: RegExp[];
  private readonly queue = new Map<string, QueueAction>();
  private readonly mutedPaths = new Set<string>();
  private syncRunning = false;

  constructor(options: SyncEngineOptions) {
    this.vault = options.vault;
    this.settings = {
      ...options.settings,
      prefix: resolveEffectivePrefix(options.settings.prefix, options.vault.getName()),
    };
    this.data = options.data;
    this.saveData = options.saveData;
    this.remote = new S3Remote(this.settings);
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

    const known = this.data.files[normalized];
    // 没有同步基线的缺失文件不能当成删除，否则新设备第一次同步会误删远端文件。
    if (known?.lastSyncedHash) {
      this.data.pendingDeletes[normalized] = {
        path: normalized,
        baseHash: known.lastSyncedHash,
        deletedAt: nowIso(),
      };
      this.queue.set(normalized, "delete");
      void this.saveData();
    }
    return true;
  }

  hasQueuedWork(): boolean {
    return this.queue.size > 0 || Object.keys(this.data.pendingDeletes).length > 0;
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
    const paths = new Set(this.vault
      .getFiles()
      .map((file) => normalizePath(file.path))
      .filter((path) => !this.shouldSkip(path)));

    for (const [path, state] of Object.entries(this.data.files)) {
      const normalized = normalizePath(path);
      if (this.shouldSkip(normalized) || state.deleted || paths.has(normalized)) {
        continue;
      }

      // 完整扫描必须反查同步基线，否则 Obsidian 关闭期间的删除无法被发现。
      if (state.lastSyncedHash) {
        this.data.pendingDeletes[normalized] = {
          path: normalized,
          baseHash: state.lastSyncedHash,
          deletedAt: nowIso(),
        };
        paths.add(normalized);
      }
    }

    return this.sync(Array.from(paths));
  }

  async resolveConflict(conflictId: string, mode: "current" | "conflict" | "both"): Promise<void> {
    const conflict = this.data.conflicts[conflictId];
    if (!conflict || conflict.resolved) {
      return;
    }

    if (mode === "conflict") {
      const conflictFile = getTFile(this.vault, conflict.conflictPath);
      if (!conflictFile) {
        throw new Error("冲突文件不存在，无法使用该版本");
      }
      const data = await this.vault.readBinary(conflictFile);
      await this.writeBinary(conflict.path, data);
      await this.vault.delete(conflictFile);
      this.queue.set(conflict.path, "upsert");
      this.data.forceUploads[conflict.path] = nowIso();
    }

    if (mode === "current") {
      const conflictFile = getTFile(this.vault, conflict.conflictPath);
      if (conflictFile) {
        await this.vault.delete(conflictFile);
      }
      this.queue.set(conflict.path, "upsert");
      this.data.forceUploads[conflict.path] = nowIso();
    }

    if (mode === "both") {
      this.queue.set(conflict.path, "upsert");
      this.data.forceUploads[conflict.path] = nowIso();
    }

    conflict.resolved = true;
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
      const snapshot = await this.loadRemoteState();
      await this.applyRemoteChanges(snapshot, new Set(paths), summary);

      const uniquePaths = new Set(paths.map((path) => normalizePath(path)));
      for (const path of Object.keys(this.data.pendingDeletes)) {
        uniquePaths.add(path);
      }

      for (const path of uniquePaths) {
        if (this.shouldSkip(path)) {
          summary.skipped += 1;
          continue;
        }

        const pendingDelete = this.data.pendingDeletes[path];
        if (pendingDelete) {
          await this.pushDelete(path, snapshot, summary);
          continue;
        }

        const file = getTFile(this.vault, path);
        if (!file) {
          summary.skipped += 1;
          continue;
        }
        await this.pushUpsert(file, snapshot, summary);
      }

      await this.writeSnapshot(snapshot);
      await this.saveData();
      return summary;
    } finally {
      this.syncRunning = false;
    }
  }

  private async loadRemoteState(): Promise<RemoteSnapshot> {
    // op log 是唯一可信来源，snapshot 只作为远端可读缓存，避免并发写 snapshot 导致状态回退。
    const snapshot: RemoteSnapshot = {
      version: 1 as const,
      createdAt: nowIso(),
      lastOpId: null,
      files: {},
    };

    const ops = await this.remote.listOpsAfter(null);
    for (const op of ops) {
      this.applyOpToSnapshot(snapshot, op);
    }
    return snapshot;
  }

  private async applyRemoteChanges(
    snapshot: RemoteSnapshot,
    localQueuedPaths: Set<string>,
    summary: SyncSummary,
  ): Promise<void> {
    for (const remoteFile of Object.values(snapshot.files)) {
      if (this.shouldSkip(remoteFile.path)) {
        continue;
      }

      const localState = this.data.files[remoteFile.path];
      if (localState?.lastRemoteOpId === remoteFile.opId || localQueuedPaths.has(remoteFile.path)) {
        continue;
      }

      if (remoteFile.deleted) {
        await this.applyRemoteDelete(remoteFile, summary);
      } else {
        await this.applyRemoteUpsert(remoteFile, summary);
      }
    }
  }

  private async applyRemoteUpsert(remoteFile: RemoteFileRecord, summary: SyncSummary): Promise<void> {
    if (!remoteFile.objectKey || !remoteFile.hash) {
      return;
    }

    const localFile = getTFile(this.vault, remoteFile.path);
    const localState = this.data.files[remoteFile.path];

    if (localFile) {
      const localContent = await this.readFileContent(localFile);
      if (localContent.hash === remoteFile.hash) {
        this.markSynced(remoteFile.path, remoteFile.hash, remoteFile.opId, false);
        return;
      }

      if (!localState?.lastSyncedHash || localContent.hash !== localState.lastSyncedHash) {
        await this.createConflictFromRemote(remoteFile, localContent.hash, summary);
        return;
      }
    }

    const data = await this.remote.downloadObject(remoteFile.objectKey);
    await this.writeBinary(remoteFile.path, data);
    this.markSynced(remoteFile.path, remoteFile.hash, remoteFile.opId, false);
    summary.downloaded += 1;
  }

  private async applyRemoteDelete(remoteFile: RemoteFileRecord, summary: SyncSummary): Promise<void> {
    const localFile = getTFile(this.vault, remoteFile.path);
    const localState = this.data.files[remoteFile.path];

    if (!localFile) {
      this.markSynced(remoteFile.path, null, remoteFile.opId, true);
      return;
    }

    const localContent = await this.readFileContent(localFile);
    if (!localState?.lastSyncedHash || localContent.hash !== localState.lastSyncedHash) {
      await this.createDeleteConflict(remoteFile, localContent.hash, summary);
      return;
    }

    this.mute(remoteFile.path);
    await this.vault.delete(localFile);
    this.markSynced(remoteFile.path, null, remoteFile.opId, true);
    summary.deleted += 1;
  }

  private async pushUpsert(file: TFile, snapshot: RemoteSnapshot, summary: SyncSummary): Promise<void> {
    const path = normalizePath(file.path);
    const content = await this.readFileContent(file);
    const localState = this.data.files[path];
    const remoteFile = snapshot.files[path];
    const forceUpload = this.data.forceUploads[path] !== undefined;

    if (localState?.lastSyncedHash === content.hash && !localState.deleted && !forceUpload) {
      if (remoteFile && remoteFile.opId !== localState.lastRemoteOpId) {
        if (remoteFile.deleted) {
          await this.applyRemoteDelete(remoteFile, summary);
          return;
        }
        if (remoteFile.hash !== content.hash) {
          await this.applyRemoteUpsert(remoteFile, summary);
          return;
        }
        this.markSynced(path, content.hash, remoteFile.opId, false);
      }
      summary.skipped += 1;
      return;
    }

    if (remoteFile && !remoteFile.deleted && remoteFile.hash === content.hash) {
      this.markSynced(path, content.hash, remoteFile.opId, false);
      delete this.data.forceUploads[path];
      summary.skipped += 1;
      return;
    }

    if (
      remoteFile &&
      !remoteFile.deleted &&
      !forceUpload &&
      (!localState?.lastSyncedHash || remoteFile.hash !== localState.lastSyncedHash)
    ) {
      await this.createConflictFromRemote(remoteFile, content.hash, summary);
      return;
    }

    const objectKey = await this.remote.uploadObject(content.hash, content.data);
    const baseHash = forceUpload ? remoteFile?.hash ?? localState?.lastSyncedHash ?? null : localState?.lastSyncedHash ?? null;
    const op = this.createOp("upsert", path, baseHash, content.hash, objectKey, content.size);
    await this.remote.appendOp(op);
    this.applyOpToSnapshot(snapshot, op);
    this.markSynced(path, content.hash, op.opId, false);
    delete this.data.forceUploads[path];
    summary.uploaded += 1;
  }

  private async pushDelete(path: string, snapshot: RemoteSnapshot, summary: SyncSummary): Promise<void> {
    const pendingDelete = this.data.pendingDeletes[path];
    const remoteFile = snapshot.files[path];
    const baseHash = pendingDelete?.baseHash ?? this.data.files[path]?.lastSyncedHash ?? null;

    if (remoteFile?.deleted) {
      this.markSynced(path, null, remoteFile.opId, true);
      delete this.data.pendingDeletes[path];
      summary.skipped += 1;
      return;
    }

    if (remoteFile && !remoteFile.deleted && baseHash && remoteFile.hash !== baseHash) {
      await this.createConflictFromRemote(remoteFile, baseHash, summary);
      delete this.data.pendingDeletes[path];
      return;
    }

    const op = this.createOp("delete", path, baseHash, null, null, 0);
    await this.remote.appendOp(op);
    this.applyOpToSnapshot(snapshot, op);
    this.markSynced(path, null, op.opId, true);
    delete this.data.pendingDeletes[path];
    summary.deleted += 1;
  }

  private async createConflictFromRemote(
    remoteFile: RemoteFileRecord,
    localHash: string | null,
    summary: SyncSummary,
  ): Promise<void> {
    if (this.hasOpenConflict(remoteFile.path, remoteFile.opId)) {
      return;
    }

    if (!remoteFile.objectKey || !remoteFile.hash) {
      return;
    }

    const remoteData = await this.remote.downloadObject(remoteFile.objectKey);
    const conflictPath = createConflictPath(remoteFile.path, remoteFile.updatedByDevice);
    await this.writeBinary(conflictPath, remoteData);
    this.recordConflict(remoteFile.path, conflictPath, localHash, remoteFile.hash, remoteFile.opId);
    summary.conflicts += 1;
  }

  private async createDeleteConflict(
    remoteFile: RemoteFileRecord,
    localHash: string | null,
    summary: SyncSummary,
  ): Promise<void> {
    if (this.hasOpenConflict(remoteFile.path, remoteFile.opId)) {
      return;
    }

    const localFile = getTFile(this.vault, remoteFile.path);
    if (!localFile) {
      return;
    }

    const localData = await this.vault.readBinary(localFile);
    const conflictPath = createConflictPath(remoteFile.path, this.data.deviceId);
    await this.writeBinary(conflictPath, localData);
    this.recordConflict(remoteFile.path, conflictPath, localHash, remoteFile.hash, remoteFile.opId);
    summary.conflicts += 1;
  }

  private recordConflict(
    path: string,
    conflictPath: string,
    localHash: string | null,
    remoteHash: string | null,
    remoteOpId: string | null,
  ): void {
    const id = randomId("conflict");
    const record: ConflictRecord = {
      id,
      path,
      conflictPath,
      localHash,
      remoteHash,
      remoteOpId,
      detectedAt: nowIso(),
      resolved: false,
    };
    this.data.conflicts[id] = record;
    new Notice(`S3 Sync 发现冲突：${path}`);
  }

  private hasOpenConflict(path: string, remoteOpId: string | null): boolean {
    return Object.values(this.data.conflicts).some((conflict) => (
      !conflict.resolved &&
      conflict.path === path &&
      conflict.remoteOpId === remoteOpId
    ));
  }

  private createOp(
    type: "upsert" | "delete",
    path: string,
    baseHash: string | null,
    newHash: string | null,
    objectKey: string | null,
    size: number,
  ): RemoteOp {
    const createdAt = nowIso();
    return {
      opId: `${createdAt.replace(/[-:.]/g, "")}-${this.data.deviceId}-${randomId("op")}`,
      type,
      path,
      deviceId: this.data.deviceId,
      baseHash,
      newHash,
      objectKey,
      size,
      createdAt,
    };
  }

  private applyOpToSnapshot(snapshot: RemoteSnapshot, op: RemoteOp): void {
    snapshot.files[op.path] = {
      path: op.path,
      hash: op.newHash,
      objectKey: op.objectKey,
      size: op.size,
      deleted: op.type === "delete",
      updatedAt: op.createdAt,
      updatedByDevice: op.deviceId,
      opId: op.opId,
    };
    snapshot.lastOpId = op.opId;
  }

  private async writeSnapshot(snapshot: RemoteSnapshot): Promise<void> {
    snapshot.createdAt = nowIso();
    await this.remote.writeSnapshot(snapshot);
  }

  private async readFileContent(file: TFile): Promise<FileContent> {
    const data = await this.vault.readBinary(file);
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
    const file = getTFile(this.vault, normalized);
    if (file) {
      await this.vault.modifyBinary(file, data);
    } else {
      await this.vault.createBinary(normalized, data);
    }
  }

  private markSynced(path: string, hash: string | null, remoteOpId: string | null, deleted: boolean): void {
    const state: LocalFileState = {
      lastSyncedHash: hash,
      lastRemoteOpId: remoteOpId,
      deleted,
      updatedAt: nowIso(),
    };
    this.data.files[normalizePath(path)] = state;
  }

  private mute(path: string): void {
    const normalized = normalizePath(path);
    this.mutedPaths.add(normalized);
    window.setTimeout(() => this.mutedPaths.delete(normalized), 3000);
  }

  private shouldSkip(path: string): boolean {
    const normalized = normalizePath(path);
    if (isIgnored(normalized, this.ignoredPatterns)) {
      return true;
    }

    return Object.values(this.data.conflicts).some((conflict) => (
      !conflict.resolved &&
      normalizePath(conflict.conflictPath) === normalized
    ));
  }
}
