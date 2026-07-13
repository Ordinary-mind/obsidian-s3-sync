import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import { ConflictModal } from "./conflict-modal";
import { createDefaultData, DEFAULT_SETTINGS } from "./defaults";
import { S3SyncSettingTab } from "./settings-tab";
import { runDesktopRuntimeContract } from "./runtime-contract";
import { RuntimeContractModal } from "./runtime-contract-modal";
import type { SyncEngine } from "./sync-engine";
import { V1RepositoryService } from "./v1-service";
import type { S3SyncData, S3SyncSettings, SyncSummary } from "./types";
import { ensureParentFolder, getTFile, resolveEffectivePrefix } from "./utils";
import { captureStableVaultFile } from "./vault-stable-capture";
import { recordPublishedWriterCommit, reserveWriterCommit } from "../core/writer-session";
import { decideResolvedRemotePut } from "../core/pull-decision";
import { conflictId } from "../core/conflict-id";
import { remoteConflictCopyPath } from "../core/conflict-copy";
import { captureEditorChange, mayApplyRemoteWithEditorIntent, observeEditorDisk } from "../core/editor-latch";
import { sha256Hex } from "../protocol/hash";
import { bindRootDeletePredecessor, clearVaultEventsThroughGeneration, latestVaultEvent, recordVaultEvent, recordVaultRename } from "../core/vault-event";
import { isVaultPathExcluded } from "../core/scope";
import { advanceApplyJournal, type ApplyJournal } from "../core/apply-journal";
import { isOwnApplyEvent } from "../core/apply-operation";
import { createRepositoryLocator } from "../core/locator";
import { assertPersistedRepositoryBinding, createPersistedRepositoryBinding } from "../core/repository-binding";
import { advanceWriterFrontiers, type CommitFrontierAnchor } from "../core/commit-frontier";

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
  private causalStatePersistence = Promise.resolve();
  private readonly v1ApplyPaths = new Set<string>();

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
      id: "s3-sync-v1-inspect-repository",
      name: "S3 Sync v1: inspect repository",
      callback: () => void this.discoverV1Repositories(),
    });

    this.addCommand({
      id: "s3-sync-v1-select-repository",
      name: "S3 Sync v1: select discovered repository",
      callback: () => void this.selectV1Repository(),
    });

    this.addCommand({
      id: "s3-sync-v1-create-repository",
      name: "S3 Sync v1: create repository",
      callback: () => void this.createV1Repository(),
    });

    this.addCommand({
      id: "s3-sync-v1-publish-active-file",
      name: "S3 Sync v1: publish active file",
      callback: () => void this.publishActiveFileV1(),
    });

    this.addCommand({
      id: "s3-sync-v1-pull-missing-files",
      name: "S3 Sync v1: pull missing files",
      callback: () => void this.pullMissingFilesV1(),
    });

    this.addCommand({
      id: "s3-sync-v1-run-desktop-runtime-contract",
      name: "S3 Sync v1: run desktop runtime contract",
      callback: () => void this.runDesktopRuntimeContract(),
    });

    this.addSettingTab(new S3SyncSettingTab(this.app, this));
    this.registerEvent(this.app.workspace.on("editor-change", (editor, info) => {
      this.editorChangeObserved = true;
      const file = info.file;
      if (!file || !this.data.v1) return;
      const path = normalizePath(file.path);
      const editorContentHash = sha256Hex(new TextEncoder().encode(editor.getValue()));
      this.data.v1DirtyIntents[path] = captureEditorChange({
        path,
        projectedHeads: this.data.v1ProjectedHeads[path] ?? [],
        projectedValueHash: this.data.files[path]?.hash,
        editorContentHash,
        existing: this.data.v1DirtyIntents[path],
      });
      this.queueCausalStatePersistence();
    }));
    this.registerV1VaultEvents();
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") this.stopSchedulingAndFlush();
    });
  }

  onunload(): void {
    this.stopSchedulingAndFlush();
  }

  async saveSettings(): Promise<void> {
    await this.savePluginData();
  }

  async saveSyncData(): Promise<void> {
    await this.savePluginData();
    this.updateStatus();
  }

  async resolveConflict(conflictId: string, mode: "local" | "remote"): Promise<void> {
    const conflict = this.data.conflicts[conflictId];
    if (conflict?.remoteVersion === 0) {
      await this.resolveV1Conflict(conflict, mode);
      return;
    }
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
      const prefix = this.getEffectivePrefix();
      const service = new V1RepositoryService(this.settings, prefix);
      const repositories = await service.discover();
      await service.probeWritableConnection(crypto.randomUUID());
      if (repositories.length === 1) {
        const existing = this.data.v1;
        const binding = createPersistedRepositoryBinding(
          this.currentV1Locator(prefix),
          repositories[0].repositoryId,
          repositories[0].descriptorHash,
          repositories[0].configDir,
          repositories[0].historicalConfigDirs,
        );
        this.data.v1 = existing?.repositoryFingerprint === binding.repositoryFingerprint
          ? { ...existing, ...binding, prefix, writerFrontiers: existing.writerFrontiers ?? {} }
          : {
            ...binding,
            prefix,
            writerFrontiers: {},
            writerId: crypto.randomUUID(),
            nextSequence: "00000000000000000001",
            previousCommitHash: null,
          };
        await this.saveSyncData();
        new Notice(`S3 Sync connected and selected repository: ${repositories[0].repositoryId}`);
        return;
      }
      new Notice(repositories.length === 0
        ? `S3 Sync connected. No repository exists at Prefix: ${prefix}`
        : `S3 Sync connected. Found ${repositories.length} repositories; select one explicitly.`);
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
      this.data.v1 = {
        ...createPersistedRepositoryBinding(
          this.currentV1Locator(this.getEffectivePrefix()),
          result.repositoryId,
          result.descriptorHash,
          this.app.vault.configDir,
          [],
        ),
        prefix: this.getEffectivePrefix(),
        writerFrontiers: {},
        writerId: crypto.randomUUID(),
        nextSequence: "00000000000000000001",
        previousCommitHash: null,
      };
      await this.saveSyncData();
      new Notice(`S3 Sync v1 repository created: ${result.repositoryId}`);
    } catch (error) {
      new Notice(`S3 Sync v1 repository creation failed: ${this.errorMessage(error)}`);
      console.error(error);
    }
  }

  private async selectV1Repository(): Promise<void> {
    try {
      const prefix = this.getEffectivePrefix();
      const repositories = await new V1RepositoryService(this.settings, prefix).discover();
      if (repositories.length !== 1) throw new Error(`expected exactly one repository, found ${repositories.length}`);
      this.data.v1 = {
        ...createPersistedRepositoryBinding(
          this.currentV1Locator(prefix),
          repositories[0].repositoryId,
          repositories[0].descriptorHash,
          repositories[0].configDir,
          repositories[0].historicalConfigDirs,
        ),
        prefix,
        writerFrontiers: {},
        writerId: crypto.randomUUID(),
        nextSequence: "00000000000000000001",
        previousCommitHash: null,
      };
      await this.saveSyncData();
      new Notice(`S3 Sync v1 repository selected: ${repositories[0].repositoryId}`);
    } catch (error) {
      new Notice(`S3 Sync v1 repository selection failed: ${this.errorMessage(error)}`);
      console.error(error);
    }
  }

  private async publishActiveFileV1(): Promise<void> {
    try {
      let state = this.data.v1;
      if (!state || state.prefix !== this.getEffectivePrefix()) {
        throw new Error("create or select a v1 repository for the current Prefix first");
      }
      await this.assertV1RepositoryBinding(state);
      const file = this.app.workspace.getActiveFile();
      if (!file) throw new Error("no active file to publish");
      const dirtyIntent = this.data.v1DirtyIntents[file.path];
      const vaultEvent = latestVaultEvent(this.data.v1VaultEvents, file.path);
      const capture = await captureStableVaultFile(this.app.vault, file.path);
      if (!capture) throw new Error("active file changed during capture or is not a regular file");
      if (
        this.data.v1DirtyIntents[file.path]?.generation !== dirtyIntent?.generation
        || latestVaultEvent(this.data.v1VaultEvents, file.path)?.generation !== vaultEvent?.generation
      ) {
        throw new Error("local causal generation changed during stable capture");
      }
      if (dirtyIntent?.awaitingLocalWrite && capture.hash !== dirtyIntent.expectedContentHash) {
        throw new Error("active editor generation has not reached stable disk bytes");
      }
      const service = new V1RepositoryService(this.settings, state.prefix);
      const pulled = await service.resolvedVaultPutWithAnchors(state.repositoryId, state.descriptorHash, file.path);
      state = await this.persistObservedCommitFrontiers(state, pulled.acceptedCommits);
      const remote = pulled.value;
      const projectedHash = this.data.files[file.path]?.hash;
      if (projectedHash && projectedHash !== capture.hash && remote && remote.hash !== projectedHash) {
        this.recordV1Conflict(file.path, projectedHash, capture.hash, remote.hash, remote.heads);
        await this.saveSyncData();
        throw new Error("local and remote content both changed; resolve the conflict before publishing");
      }
      const parents = dirtyIntent?.basisHeads ?? vaultEvent?.basisHeads ?? remote?.heads ?? [];
      const reservation = reserveWriterCommit(state);
      const published = await service.publishVaultPut({
        repositoryId: state.repositoryId,
        descriptorHash: state.descriptorHash,
        writerId: state.writerId,
        sequence: reservation.sequence,
        previousCommitHash: reservation.previousCommitHash,
        createdAt: new Date().toISOString(),
        clientVersion: this.manifest.version,
        path: file.path,
        parents,
        capture,
        writerFrontiers: state.writerFrontiers,
      });
      const commitHash = published.hash;
      this.data.v1 = {
        ...state,
        ...recordPublishedWriterCommit(state, commitHash, () => crypto.randomUUID()),
        writerFrontiers: advanceWriterFrontiers(state.writerFrontiers, [published]),
      };
      await this.savePluginData();
      this.data.files[file.path] = { hash: capture.hash, size: capture.size, updatedAt: new Date().toISOString() };
      this.data.v1ProjectedHeads[file.path] = [`${commitHash}:0:0`];
      if (dirtyIntent?.localCandidates.length) {
        this.data.v1RecoveryCandidates[file.path] = dirtyIntent.localCandidates.map((candidate) => ({ ...candidate }));
      }
      delete this.data.v1DirtyIntents[file.path];
      if (vaultEvent) {
        this.data.v1VaultEvents = clearVaultEventsThroughGeneration(this.data.v1VaultEvents, file.path, vaultEvent.generation);
      }
      if (parents.length === 0) {
        this.data.v1VaultEvents = bindRootDeletePredecessor(this.data.v1VaultEvents, file.path, vaultEvent?.generation ?? 0, `${commitHash}:0:0`);
      }
      await this.saveSyncData();
      new Notice(`S3 Sync v1 published: ${file.path}`);
    } catch (error) {
      new Notice(`S3 Sync v1 publish failed: ${this.errorMessage(error)}`);
      console.error(error);
    }
  }

  private async pullMissingFilesV1(): Promise<void> {
    try {
      let state = this.data.v1;
      if (!state || state.prefix !== this.getEffectivePrefix()) throw new Error("select a v1 repository for the current Prefix first");
      await this.assertV1RepositoryBinding(state);
      const pulled = await new V1RepositoryService(this.settings, state.prefix).listResolvedVaultPutsWithDiagnostics(state.repositoryId, state.descriptorHash);
      state = await this.persistObservedCommitFrontiers(state, pulled.acceptedCommits);
      const files = pulled.files;
      let created = 0;
      let updated = 0;
      let skipped = 0;
      let conflicts = 0;
      for (const remote of files) {
        if (!mayApplyRemoteWithEditorIntent(this.data.v1DirtyIntents[remote.path]) || latestVaultEvent(this.data.v1VaultEvents, remote.path)) {
          skipped += 1;
          continue;
        }
        const existing = getTFile(this.app.vault, remote.path);
        const capture = existing ? await captureStableVaultFile(this.app.vault, remote.path) : undefined;
        const decision = decideResolvedRemotePut({ localExists: !!existing, projectedHash: this.data.files[remote.path]?.hash, currentHash: capture?.hash, remoteHash: remote.hash });
        if (decision === "conflict") {
          const conflict = this.recordV1Conflict(remote.path, this.data.files[remote.path]?.hash ?? null, capture?.hash ?? null, remote.hash, remote.heads);
          const copyPath = remoteConflictCopyPath(conflict, remote.hash);
          if (!this.app.vault.getAbstractFileByPath(copyPath)) {
            await ensureParentFolder(this.app.vault, copyPath);
            const bytes = new Uint8Array(remote.bytes.byteLength);
            bytes.set(remote.bytes);
            try {
              await this.app.vault.createBinary(copyPath, bytes.buffer);
            } catch (error) {
              if (!(error instanceof Error) || !error.message.includes("File already exists")) throw error;
            }
          }
          conflicts += 1;
          skipped += 1;
          continue;
        }
        if (decision === "adopt") {
          this.data.files[remote.path] = { hash: remote.hash, size: remote.size, updatedAt: new Date().toISOString() };
          this.data.v1ProjectedHeads[remote.path] = [...remote.heads];
          continue;
        }
        const binary = new Uint8Array(remote.bytes.byteLength);
        binary.set(remote.bytes);
        if (decision === "create") {
          await ensureParentFolder(this.app.vault, remote.path);
          if (this.app.vault.getAbstractFileByPath(remote.path)) { skipped += 1; continue; }
          await this.withV1ApplyPath(remote.path, remote.hash, () => this.app.vault.createBinary(remote.path, binary.buffer));
          created += 1;
        } else {
          await this.withV1ApplyPath(remote.path, remote.hash, () => this.app.vault.modifyBinary(existing!, binary.buffer));
          updated += 1;
        }
        this.data.files[remote.path] = { hash: remote.hash, size: remote.size, updatedAt: new Date().toISOString() };
        this.data.v1ProjectedHeads[remote.path] = [...remote.heads];
      }
      await this.saveSyncData();
      new Notice(`S3 Sync v1 pull: created ${created}, updated ${updated}, conflicts ${conflicts}, skipped ${skipped}`);
      if (conflicts > 0) new ConflictModal(this).open();
    } catch (error) {
      new Notice(`S3 Sync v1 pull failed: ${this.errorMessage(error)}`);
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

  private currentV1Locator(prefix: string) {
    return createRepositoryLocator(
      {
        endpoint: this.settings.endpoint,
        region: this.settings.region,
        bucket: this.settings.bucket,
        forcePathStyle: this.settings.forcePathStyle,
        prefix,
      },
      this.settings.endpoint.startsWith("http://127.0.0.1") || this.settings.endpoint.startsWith("http://localhost"),
    );
  }

  private async assertV1RepositoryBinding(state: NonNullable<S3SyncData["v1"]>): Promise<void> {
    assertPersistedRepositoryBinding(state, this.currentV1Locator(this.getEffectivePrefix()), this.app.vault.configDir, state.historicalConfigDirs);
    await new V1RepositoryService(this.settings, state.prefix).assertDescriptorBinding(state.repositoryId, state.descriptorHash, state);
  }

  private async persistObservedCommitFrontiers(
    state: NonNullable<S3SyncData["v1"]>,
    commits: readonly CommitFrontierAnchor[],
  ): Promise<NonNullable<S3SyncData["v1"]>> {
    const updated = { ...state, writerFrontiers: advanceWriterFrontiers(state.writerFrontiers ?? {}, commits) };
    this.data.v1 = updated;
    await this.savePluginData();
    return updated;
  }

  private registerV1VaultEvents(): void {
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (!(file instanceof TFile)) return;
      const path = normalizePath(file.path);
      void this.handleV1UpsertEvent(file, path);
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (!(file instanceof TFile)) return;
      const path = normalizePath(file.path);
      void this.handleV1UpsertEvent(file, path);
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (!(file instanceof TFile)) return;
      const path = normalizePath(file.path);
      if (isOwnApplyEvent(this.data.v1ApplyJournals, path, undefined)) return;
      this.recordV1VaultEvent("delete", path);
      this.recordEditorDeleteCandidate(path);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (!(file instanceof TFile) || !this.data.v1) return;
      const normalizedOldPath = normalizePath(oldPath);
      const newPath = normalizePath(file.path);
      if (!this.isV1ManagedVaultPath(normalizedOldPath) || !this.isV1ManagedVaultPath(newPath)) return;
      if (this.v1ApplyPaths.has(normalizedOldPath) || this.v1ApplyPaths.has(newPath)) return;
      const transactionId = crypto.randomUUID();
      this.data.v1VaultEvents = recordVaultRename(this.data.v1VaultEvents, {
        transactionId,
        deleteId: crypto.randomUUID(),
        upsertId: crypto.randomUUID(),
        oldPath: normalizedOldPath,
        newPath,
        oldProjectedHeads: this.data.v1ProjectedHeads[normalizedOldPath] ?? [],
        newProjectedHeads: this.data.v1ProjectedHeads[newPath] ?? [],
        oldPreviousGeneration: this.data.v1VaultGenerations[normalizedOldPath] ?? 0,
        newPreviousGeneration: this.data.v1VaultGenerations[newPath] ?? 0,
      });
      this.data.v1VaultGenerations[normalizedOldPath] = latestVaultEvent(this.data.v1VaultEvents, normalizedOldPath)!.generation;
      this.data.v1VaultGenerations[newPath] = latestVaultEvent(this.data.v1VaultEvents, newPath)!.generation;
      this.recordEditorDeleteCandidate(normalizedOldPath);
      this.queueCausalStatePersistence();
    }));
  }

  private recordV1VaultEvent(kind: "upsert" | "delete", path: string): void {
    if (!this.data.v1 || !this.isV1ManagedVaultPath(path) || this.v1ApplyPaths.has(path)) return;
    this.data.v1VaultEvents = recordVaultEvent(this.data.v1VaultEvents, {
      id: crypto.randomUUID(),
      kind,
      path,
      projectedHeads: this.data.v1ProjectedHeads[path] ?? [],
      previousGeneration: this.data.v1VaultGenerations[path] ?? 0,
    });
    this.data.v1VaultGenerations[path] = latestVaultEvent(this.data.v1VaultEvents, path)!.generation;
    this.queueCausalStatePersistence();
  }

  private async handleV1UpsertEvent(file: TFile, path: string): Promise<void> {
    if (!this.data.v1 || !this.isV1ManagedVaultPath(path) || this.v1ApplyPaths.has(path)) return;
    const applyJournals = this.data.v1ApplyJournals.map((journal) => ({ ...journal }));
    const capture = await captureStableVaultFile(this.app.vault, file.path);
    if (capture && isOwnApplyEvent(applyJournals, path, capture.hash)) return;
    this.recordV1VaultEvent("upsert", path);
    if (capture) this.recordEditorPutCandidate(path, capture.hash);
  }

  private isV1ManagedVaultPath(path: string): boolean {
    return !isVaultPathExcluded(path, this.app.vault.configDir, []);
  }

  private recordEditorPutCandidate(path: string, hash: string): void {
    const intent = this.data.v1DirtyIntents[path];
    if (!intent) return;
    this.data.v1DirtyIntents[path] = observeEditorDisk(intent, { kind: "put", hash }, false).intent;
    this.queueCausalStatePersistence();
  }

  private recordEditorDeleteCandidate(path: string): void {
    const intent = this.data.v1DirtyIntents[path];
    if (!intent) return;
    this.data.v1DirtyIntents[path] = observeEditorDisk(intent, { kind: "delete" }, false).intent;
  }

  private queueCausalStatePersistence(): void {
    this.causalStatePersistence = this.causalStatePersistence
      .then(() => this.savePluginData())
      .catch((error) => console.error("S3 Sync failed to persist v1 causal state", error));
  }

  private stopSchedulingAndFlush(): void {
    if (this.syncTimer !== null) {
      window.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    this.queueCausalStatePersistence();
  }

  private async withV1ApplyPath<T>(path: string, targetHash: string | undefined, operation: () => Promise<T>): Promise<T> {
    const journal: ApplyJournal = {
      operationId: crypto.randomUUID(),
      path,
      expectedBeforeHash: this.data.files[path]?.hash,
      targetHash,
      state: "prepared",
    };
    this.data.v1ApplyJournals.push(journal);
    try {
      await this.savePluginData();
    } catch (error) {
      this.data.v1ApplyJournals = this.data.v1ApplyJournals.filter((entry) => entry.operationId !== journal.operationId);
      throw error;
    }
    this.v1ApplyPaths.add(path);
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      this.data.v1ApplyJournals = this.data.v1ApplyJournals.map((entry) => entry.operationId === journal.operationId
        ? advanceApplyJournal(entry, "recovery-required")
        : entry);
      await this.savePluginData();
      throw error;
    } finally {
      this.v1ApplyPaths.delete(path);
    }
    this.data.v1ApplyJournals = this.data.v1ApplyJournals.filter((entry) => entry.operationId !== journal.operationId);
    await this.savePluginData();
    return result;
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
          v1RemoteHeads: Array.isArray(conflict.v1RemoteHeads) && conflict.v1RemoteHeads.every((head) => typeof head === "string") ? [...conflict.v1RemoteHeads] : undefined,
          detectedAt: conflict.detectedAt ?? new Date().toISOString(),
          resolved: conflict.resolved ?? false,
        };
      }
    }
    const conflictKeys = new Map<string, string>();
    for (const [id, conflict] of Object.entries(conflicts)) {
      const key = `${conflict.path}\u0000${conflict.baseHash ?? "none"}\u0000${conflict.localHash ?? "none"}\u0000${conflict.remoteHash ?? "none"}`;
      const previousId = conflictKeys.get(key);
      if (!previousId) {
        conflictKeys.set(key, id);
      } else if (conflicts[previousId].detectedAt >= conflict.detectedAt) {
        delete conflicts[id];
      } else {
        delete conflicts[previousId];
        conflictKeys.set(key, id);
      }
    }

    this.data = {
      ...defaultData,
      ...(persisted?.syncData ?? {}),
      lastSyncedVersion: persisted?.syncData?.lastSyncedVersion ?? 0,
      files,
      conflicts,
      v1DirtyIntents: persisted?.syncData?.v1DirtyIntents ?? {},
      v1ProjectedHeads: persisted?.syncData?.v1ProjectedHeads ?? {},
      v1VaultEvents: persisted?.syncData?.v1VaultEvents ?? [],
      v1VaultGenerations: persisted?.syncData?.v1VaultGenerations ?? {},
      v1RecoveryCandidates: persisted?.syncData?.v1RecoveryCandidates ?? {},
      v1ApplyJournals: persisted?.syncData?.v1ApplyJournals ?? [],
    };
  }

  private async savePluginData(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      syncData: this.data,
    });
  }

  private recordV1Conflict(path: string, baseHash: string | null, localHash: string | null, remoteHash: string, remoteHeads: string[] = []): string {
    const id = conflictId(this.data.v1?.repositoryId ?? "unknown", "vault", [path], [baseHash ?? "none", localHash ?? "none", remoteHash]);
    for (const [existingId, existing] of Object.entries(this.data.conflicts)) {
      if (
        existingId !== id
        && !existing.resolved
        && existing.path === path
        && existing.baseHash === baseHash
        && existing.localHash === localHash
        && existing.remoteHash === remoteHash
      ) {
        delete this.data.conflicts[existingId];
      }
    }
    this.data.conflicts[id] = {
      id,
      path,
      baseHash,
      localHash,
      remoteHash,
      remoteVersion: 0,
      localDeviceId: this.data.v1?.writerId,
      v1RemoteHeads: [...remoteHeads],
      detectedAt: new Date().toISOString(),
      resolved: false,
    };
    return id;
  }

  private async resolveV1Conflict(conflict: S3SyncData["conflicts"][string], mode: "local" | "remote"): Promise<void> {
      let state = this.data.v1;
      if (!state) throw new Error("v1 repository is not selected");
      await this.assertV1RepositoryBinding(state);
      const service = new V1RepositoryService(this.settings, state.prefix);
    const pulled = await service.resolvedVaultPutWithAnchors(state.repositoryId, state.descriptorHash, conflict.path);
    state = await this.persistObservedCommitFrontiers(state, pulled.acceptedCommits);
    const remote = pulled.value;
    if (!remote || remote.hash !== conflict.remoteHash || !sameHeads(remote.heads, conflict.v1RemoteHeads ?? [])) throw new Error("remote conflict changed; refresh before resolving");
    if (mode === "remote") {
      const candidate = (await service.listResolvedVaultPuts(state.repositoryId, state.descriptorHash)).find((entry) => entry.path === conflict.path);
      if (!candidate) throw new Error("remote conflict content is unavailable");
      const bytes = new Uint8Array(candidate.bytes.byteLength);
      bytes.set(candidate.bytes);
      const file = getTFile(this.app.vault, conflict.path);
      if (!file) throw new Error("local conflict file is missing");
      await this.app.vault.modifyBinary(file, bytes.buffer);
      this.data.files[conflict.path] = { hash: candidate.hash, size: candidate.size, updatedAt: new Date().toISOString() };
    } else {
      const capture = await captureStableVaultFile(this.app.vault, conflict.path);
      if (!capture || capture.hash !== conflict.localHash) throw new Error("local conflict content changed; refresh before resolving");
      const reservation = reserveWriterCommit(state);
      const published = await service.publishVaultPut({ repositoryId: state.repositoryId, descriptorHash: state.descriptorHash, writerId: state.writerId, sequence: reservation.sequence, previousCommitHash: reservation.previousCommitHash, createdAt: new Date().toISOString(), clientVersion: this.manifest.version, path: conflict.path, parents: remote.heads, capture, writerFrontiers: state.writerFrontiers });
      const commitHash = published.hash;
      this.data.v1 = { ...state, ...recordPublishedWriterCommit(state, commitHash, () => crypto.randomUUID()), writerFrontiers: advanceWriterFrontiers(state.writerFrontiers, [published]) };
      await this.savePluginData();
      this.data.files[conflict.path] = { hash: capture.hash, size: capture.size, updatedAt: new Date().toISOString() };
    }
    this.data.conflicts[conflict.id] = { ...conflict, resolved: true };
    await this.saveSyncData();
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

function sameHeads(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((head, index) => head === normalizedRight[index]);
}
