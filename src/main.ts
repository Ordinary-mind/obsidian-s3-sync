import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import { ConflictModal } from "./conflict-modal";
import { createDefaultData, DEFAULT_SETTINGS } from "./defaults";
import { S3SyncSettingTab } from "./settings-tab";
import { runDesktopRuntimeContract } from "./runtime-contract";
import { RuntimeContractModal } from "./runtime-contract-modal";
import type { SyncEngine } from "./sync-engine";
import { V1RepositoryService } from "./v1-service";
import type { S3SyncData, S3SyncSettings, SyncSummary } from "./types";
import { getTFile, resolveEffectivePrefix } from "./utils";

interface PersistedPluginData {
  settings?: Partial<S3SyncSettings>;
  syncData?: Partial<S3SyncData>;
}

export default class S3SyncPlugin extends Plugin {
  settings: S3SyncSettings = { ...DEFAULT_SETTINGS };
  data: S3SyncData = createDefaultData();

  private engine: SyncEngine | null = null;
  private syncTimer: number | null = null;
  private statusEl: HTMLElement | null = null;
  private readonly runtimeContractSessionId = crypto.randomUUID();
  private editorChangeObserved = false;

  async onload(): Promise<void> {
    await this.loadPluginData();

    this.statusEl = this.addStatusBarItem();
    this.updateStatus();

    this.addCommand({
      id: "s3-sync-open-conflicts",
      name: "S3 Sync：打开冲突列表",
      callback: () => new ConflictModal(this).open(),
    });

    this.addCommand({
      id: "s3-sync-v1-discover-repositories",
      name: "S3 Sync：发现 v1 仓库（只读）",
      callback: () => void this.discoverV1Repositories(),
    });

    this.addCommand({
      id: "s3-sync-v1-create-repository",
      name: "S3 Sync v1: create repository",
      callback: () => void this.createV1Repository(),
    });

    this.addCommand({
      id: "s3-sync-v1-run-desktop-runtime-contract",
      name: "S3 Sync v1: run desktop runtime contract",
      callback: () => void this.runDesktopRuntimeContract(),
    });

    this.addSettingTab(new S3SyncSettingTab(this.app, this));
    this.registerEvent(this.app.workspace.on("editor-change", () => {
      this.editorChangeObserved = true;
    }));

  }

  onunload(): void {
    if (this.syncTimer !== null) {
      window.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  async saveSettings(): Promise<void> {
    await this.savePluginData();
  }

  async saveSyncData(): Promise<void> {
    await this.savePluginData();
    this.updateStatus();
  }

  async resolveConflict(conflictId: string, mode: "local" | "remote"): Promise<void> {
    await this.engineOrThrow().resolveConflict(conflictId, mode);
    this.updateStatus();
  }

  async openFile(path: string): Promise<void> {
    const file = getTFile(this.app.vault, path);
    if (!file) {
      new Notice(`文件不存在：${path}`);
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  getEffectivePrefix(): string {
    return resolveEffectivePrefix(this.settings.prefix, this.app.vault.getName());
  }

  async testS3Connection(): Promise<void> {
    try {
      const service = new V1RepositoryService(this.settings, this.getEffectivePrefix());
      await service.discover();
      await service.probeWritableConnection(crypto.randomUUID());
      new Notice(`S3 Sync 连接成功，当前 Prefix：${this.getEffectivePrefix()}`);
    } catch (error) {
      new Notice(`S3 Sync 连接失败：${this.errorMessage(error)}`);
      console.error(error);
    }
  }

  async discoverV1Repositories(): Promise<void> {
    try {
      const repositories = await new V1RepositoryService(this.settings, this.getEffectivePrefix()).discover();
      if (repositories.length !== 1) {
        new Notice(`S3 Sync v1：发现 ${repositories.length} 个已验证仓库；多仓库需显式选择`);
        return;
      }
      const summary = await new V1RepositoryService(this.settings, this.getEffectivePrefix()).inspect(repositories[0].repositoryId, repositories[0].descriptorHash);
      new Notice(`S3 Sync v1：已只读验证 ${summary.registers} 个寄存器；冲突 ${summary.concurrent}，等待依赖 ${summary.pending}，无效 ${summary.invalid}`);
    } catch (error) {
      new Notice(`S3 Sync v1 仓库发现失败：${this.errorMessage(error)}`);
      console.error(error);
    }
  }

  private async createV1Repository(): Promise<void> {
    try {
      const result = await new V1RepositoryService(this.settings, this.getEffectivePrefix()).createRepository(
        crypto.randomUUID(),
        this.app.vault.configDir,
      );
      new Notice(`S3 Sync v1 repository created: ${result.repositoryId}`);
    } catch (error) {
      new Notice(`S3 Sync v1 repository creation failed: ${this.errorMessage(error)}`);
      console.error(error);
    }
  }

  private async runDesktopRuntimeContract(): Promise<void> {
    try {
      const result = await runDesktopRuntimeContract(
        this.app.vault.adapter,
        this.app.vault.configDir,
        this.manifest.id,
        this.runtimeContractSessionId,
        this.editorChangeObserved,
      );
      new RuntimeContractModal(this.app, result).open();
    } catch (error) {
      new Notice(`S3 Sync v1 runtime contract failed: ${this.errorMessage(error)}`);
      console.error(error);
    }
  }

  private registerVaultEvents(): void {
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file instanceof TFile) {
        this.queueUpsert(file);
      }
    }));

    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile) {
        this.queueUpsert(file);
      }
    }));

    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file instanceof TFile) {
        this.queueDelete(file.path);
      }
    }));

    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile) {
        // rename 在同步层按“旧路径删除 + 新路径上传”处理，先保证语义清楚。
        this.queueDelete(oldPath);
        this.queueUpsert(file);
      }
    }));
  }

  private queueUpsert(file: TFile): void {
    const engine = this.engineOrThrow();
    const path = normalizePath(file.path);
    if (engine.isMuted(path)) {
      return;
    }
    if (engine.queueUpsert(file)) {
      this.scheduleSync();
    }
  }

  private queueDelete(path: string): void {
    const engine = this.engineOrThrow();
    if (engine.isMuted(path)) {
      return;
    }
    if (engine.queueDelete(path)) {
      this.scheduleSync();
    }
  }

  private scheduleSync(): void {
    this.updateStatus();
    if (!this.settings.autoSync) {
      return;
    }

    if (this.syncTimer !== null) {
      window.clearTimeout(this.syncTimer);
    }
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      void this.syncNow();
    }, Math.max(1, this.settings.debounceSeconds) * 1000);
  }

  private async syncNow(): Promise<void> {
    const engine = this.engineOrThrow();
    let succeeded = false;
    try {
      const summary = await engine.syncQueued();
      await this.saveSyncData();
      this.showSummary(summary);
      succeeded = true;
    } catch (error) {
      new Notice(`S3 Sync 同步失败：${this.errorMessage(error)}`);
      console.error(error);
    } finally {
      this.updateStatus();
      if (succeeded && this.settings.autoSync && engine.hasQueuedWork()) {
        this.scheduleSync();
      }
    }
  }

  private async smartSync(): Promise<void> {
    const engine = this.engineOrThrow();
    if (engine.hasQueuedWork()) {
      await this.syncNow();
    } else {
      await this.syncAllKnownFiles();
    }
  }

  private async syncAllKnownFiles(): Promise<void> {
    const engine = this.engineOrThrow();
    let succeeded = false;
    try {
      const summary = await engine.syncAllKnownFiles();
      await this.saveSyncData();
      this.showSummary(summary);
      succeeded = true;
    } catch (error) {
      new Notice(`S3 Sync 完整同步失败：${this.errorMessage(error)}`);
      console.error(error);
    } finally {
      this.updateStatus();
      if (succeeded && this.settings.autoSync && engine.hasQueuedWork()) {
        this.scheduleSync();
      }
    }
  }

  private showSummary(summary: SyncSummary): void {
    new Notice(
      `S3 Sync 完成：上传 ${summary.uploaded}，下载 ${summary.downloaded}，删除 ${summary.deleted}，冲突 ${summary.conflicts}，跳过 ${summary.skipped}`,
    );
    if (summary.conflicts > 0) {
      new ConflictModal(this).open();
    }
  }

  private updateStatus(): void {
    if (!this.statusEl) {
      return;
    }
    const conflictCount = Object.values(this.data.conflicts).filter((conflict) => !conflict.resolved).length;
    const queueCount = this.engine?.hasQueuedWork() ? "有待同步" : "空闲";
    this.statusEl.setText(`S3 Sync：${queueCount}${conflictCount > 0 ? `，冲突 ${conflictCount}` : ""}`);
  }

  private rebuildEngine(): void {
    throw new Error("Legacy sync engine is disabled for v1");
  }

  private engineOrThrow(): SyncEngine {
    if (!this.engine) {
      throw new Error("同步引擎尚未初始化");
    }
    return this.engine;
  }

  private async loadPluginData(): Promise<void> {
    const persisted = (await this.loadData()) as PersistedPluginData | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(persisted?.settings ?? {}),
    };

    const defaultData = createDefaultData();
    const files: S3SyncData["files"] = {};
    const persistedFiles = persisted?.syncData?.files ?? {};
    for (const [path, value] of Object.entries(persistedFiles)) {
      const record = value as { hash?: string; lastSyncedHash?: string; size?: number; updatedAt?: string };
      const hash = record.hash ?? record.lastSyncedHash;
      if (hash) {
        files[path] = {
          hash,
          size: record.size ?? 0,
          updatedAt: record.updatedAt ?? new Date().toISOString(),
        };
      }
    }

    const conflicts: S3SyncData["conflicts"] = {};
    for (const [id, value] of Object.entries(persisted?.syncData?.conflicts ?? {})) {
      const conflict = value as Partial<S3SyncData["conflicts"][string]>;
      if (
        typeof conflict.path === "string" &&
        "baseHash" in conflict &&
        "localHash" in conflict &&
        "remoteHash" in conflict &&
        typeof conflict.remoteVersion === "number"
      ) {
        conflicts[id] = {
          id,
          path: conflict.path,
          baseHash: conflict.baseHash ?? null,
          localHash: conflict.localHash ?? null,
          remoteHash: conflict.remoteHash ?? null,
          remoteVersion: conflict.remoteVersion,
          localDeviceId: conflict.localDeviceId,
          remoteUpdatedByDevice: conflict.remoteUpdatedByDevice,
          detectedAt: conflict.detectedAt ?? new Date().toISOString(),
          resolved: conflict.resolved ?? false,
        };
      }
    }

    this.data = {
      ...defaultData,
      ...(persisted?.syncData ?? {}),
      lastSyncedVersion: persisted?.syncData?.lastSyncedVersion ?? 0,
      files,
      conflicts,
    };
  }

  private async savePluginData(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      syncData: this.data,
    });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
