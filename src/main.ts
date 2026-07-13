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
import { DurableStateStore, type StateJsonValue } from "../core/durable-state";
import { openRepositoryStateFiles } from "../core/local-state-files";
import { repositoryDurablePayload } from "../core/repository-durable-payload";
import { validateRepositoryStatePayload, writeRepositoryStateTransaction } from "../core/repository-state-transaction";
import { advanceIngestedCommitState } from "../core/ingested-state";
import { mergeVerifiedRegisterObservations, type VerifiedRegisterObservation } from "../core/remote-merge-state";
import { assertPluginDataContainsNoOperationalState, type PersistedRepositorySelection } from "../core/plugin-data";
import type { DurableOutboxEntry } from "../core/durable-outbox";
import { SyncDashboardModal } from "./sync-dashboard-modal";
import { buildRedactedDiagnosticBundle } from "../core/diagnostic-bundle";
import { diagnosticCategory } from "../core/diagnostics";
import { repositoryHealthLabel, type OperationalStatus, type PathDecisionRecord } from "../core/operational-status";

interface PersistedPluginData {
  schemaVersion?: 2;
  settings?: Partial<S3SyncSettings>;
  repositorySelection?: PersistedRepositorySelection & { prefix: string };
  preferences?: { dashboardExpanded?: boolean };
  // 仅用于从旧版本一次性迁移，v2 不再写入该字段。
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
  private v1DurableState: { fingerprint: string; store: DurableStateStore<StateJsonValue> } | undefined;

  async onload(): Promise<void> {
    await this.loadPluginData();

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addEventListener("click", () => new SyncDashboardModal(this).open());
    this.updateStatus();

    this.addCommand({
      id: "s3-sync-dashboard",
      name: "S3 Sync：状态与诊断",
      callback: () => new SyncDashboardModal(this).open(),
    });

    this.addCommand({
      id: "s3-sync-now",
      name: "S3 Sync：立即同步",
      callback: () => void this.runManualSyncV1(),
    });

    this.addCommand({
      id: "s3-sync-preview",
      name: "S3 Sync：仅预览",
      callback: () => void this.previewSyncV1(),
    });

    this.addCommand({
      id: "s3-sync-full-audit",
      name: "S3 Sync：完整校验",
      callback: () => void this.runFullAuditV1(),
    });

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

  getOperationalStatus(): OperationalStatus {
    const base = this.data.v1OperationalStatus;
    const recoveryRecords = Object.values(this.data.v1RecoveryRecords);
    return {
      ...base,
      pendingApply: Object.keys(this.data.v1PendingApply).length,
      outbox: this.data.v1DurableOutbox.filter((entry) => entry.state !== "published").length,
      localConcurrentRecords: Object.keys(this.data.v1LocalConcurrentRecords).length,
      recoveryFiles: recoveryRecords.filter((record) => record.cleanupState !== "cleaned").length,
      postCaptureEdits: recoveryRecords.filter((record) => record.postCaptureEdit).length,
      conflicts: Object.values(this.data.conflicts).filter((conflict) => !conflict.resolved).length,
      recoveryRequired: base.recoveryRequired || this.data.v1ApplyJournals.some((journal) => journal.state === "recovery-required"),
      repositoryIdentityValid: base.repositoryIdentityValid && !this.data.v1ReattachRequired,
    };
  }

  openConflictModal(): void { new ConflictModal(this).open(); }

  async runManualSyncV1(): Promise<void> {
    if (!this.data.v1 || this.data.v1ReattachRequired) {
      new Notice("S3 Sync：需要先完成非破坏性仓库接入或恢复诊断。");
      return;
    }
    this.updateOperationalStatus({ phase: "pulling", lastError: undefined });
    try {
      await this.pullMissingFilesV1();
      this.updateOperationalStatus({ lastSuccessfulPull: Date.now(), phase: "scanning" });
      const active = this.app.workspace.getActiveFile();
      if (active && (this.data.v1DirtyIntents[active.path] || latestVaultEvent(this.data.v1VaultEvents, active.path))) {
        this.updateOperationalStatus({ phase: "publishing" });
        await this.publishActiveFileV1();
        this.updateOperationalStatus({ lastSuccessfulPublish: Date.now() });
      }
      this.updateOperationalStatus({ phase: "idle" });
    } catch (error) {
      this.recordOperationalError(error);
    }
    this.updateStatus();
  }

  async previewSyncV1(): Promise<void> {
    const state = this.data.v1;
    if (!state) { new Notice("S3 Sync：尚未选择 v1 仓库。"); return; }
    this.updateOperationalStatus({ phase: "previewing", decisions: [], lastError: undefined });
    try {
      await this.assertV1RepositoryBinding(state);
      const pulled = await new V1RepositoryService(this.settings, state.prefix).listResolvedVaultPutsWithDiagnostics(state.repositoryId, state.descriptorHash);
      const decisions: PathDecisionRecord[] = [];
      const remotePaths = new Set<string>();
      for (const remote of pulled.files) {
        remotePaths.add(remote.path);
        const existing = getTFile(this.app.vault, remote.path);
        const local = existing ? await captureStableVaultFile(this.app.vault, remote.path) : undefined;
        if (existing && !local) decisions.push({ path: remote.path, decision: "unknown", reason: "本地文件未稳定或无法读取" });
        else if (!local) decisions.push({ path: remote.path, decision: "remote-put", reason: "本地缺失，仅计划安全创建" });
        else if (local.hash === remote.hash) decisions.push({ path: remote.path, decision: "same", reason: "本地与远端字节相同" });
        else if (this.data.v1DirtyIntents[remote.path] || latestVaultEvent(this.data.v1VaultEvents, remote.path)) decisions.push({ path: remote.path, decision: "conflict", reason: "本地已有未发布意图" });
        else decisions.push({ path: remote.path, decision: "remote-put", reason: "需经过前像与 no-clobber 守卫" });
      }
      for (const blocked of pulled.blocked) decisions.push({ path: blocked.path, decision: "unknown", reason: this.errorMessage(blocked.reason) });
      for (const path of Object.keys(this.data.files)) {
        if (!remotePaths.has(path) && getTFile(this.app.vault, path)) decisions.push({ path, decision: "local-put", reason: "远端没有已解析值；不会推断远端删除" });
      }
      this.updateOperationalStatus({ phase: "idle", decisions: decisions.sort((left, right) => left.path.localeCompare(right.path)) });
      new SyncDashboardModal(this).open();
    } catch (error) {
      this.recordOperationalError(error);
    }
    this.updateStatus();
  }

  async runFullAuditV1(): Promise<void> {
    const state = this.data.v1;
    if (!state) { new Notice("S3 Sync：尚未选择 v1 仓库。"); return; }
    this.updateOperationalStatus({ phase: "auditing", audit: { state: "running", completedObjects: 0, totalObjects: 0, missingClosure: [], resumable: true } });
    try {
      await this.assertV1RepositoryBinding(state);
      const result = await new V1RepositoryService(this.settings, state.prefix).fullAudit(state.repositoryId, state.descriptorHash);
      const now = Date.now();
      this.updateOperationalStatus({
        phase: "idle",
        lastSuccessfulAudit: now,
        audit: { state: "complete", completedObjects: result.verifiedObjects, totalObjects: result.verifiedObjects, missingClosure: [], resumable: false, completedAt: now },
      });
      await this.saveSyncData();
      new Notice(`S3 Sync 完整校验通过：${result.verifiedObjects} 个对象，${result.commits} 个 Commit。`);
    } catch (error) {
      this.updateOperationalStatus({ audit: { ...this.data.v1OperationalStatus.audit, state: "failed", resumable: true } });
      this.recordOperationalError(error);
    }
    this.updateStatus();
  }

  exportRedactedDiagnostics(): string {
    const status = this.getOperationalStatus();
    return JSON.stringify(buildRedactedDiagnosticBundle({
      generatedAt: Date.now(),
      repositoryId: this.data.v1?.repositoryId,
      normalizedPrefix: this.data.v1?.prefix,
      pathSalt: this.data.v1?.repositoryId ?? this.runtimeContractSessionId,
      sensitiveValues: [this.settings.accessKeyId, this.settings.secretAccessKey],
      status: status as unknown as Record<string, unknown>,
      events: [
        ...status.decisions.map((decision) => ({ at: Date.now(), category: decision.decision === "conflict" ? "conflict" as const : "local-path" as const, stage: decision.decision, message: decision.reason, path: decision.path })),
        ...(status.lastError ? [{ at: Date.now(), category: status.lastError.category, stage: status.phase, message: status.lastError.message }] : []),
      ],
    }), null, 2);
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
      state = await this.persistObservedRemoteState(state, pulled.acceptedCommits, pulled.observations);
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
      delete this.data.v1PendingApply[file.path];
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
      state = await this.persistObservedRemoteState(state, pulled.acceptedCommits, pulled.blockedCommitKeys.length === 0 ? pulled.observations : undefined);
      if (pulled.blockedCommitKeys.length > 0) throw pulled.blockedCommitKeys[0].reason;
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
          delete this.data.v1PendingApply[remote.path];
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
        delete this.data.v1PendingApply[remote.path];
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

  private async persistObservedRemoteState(
    state: NonNullable<S3SyncData["v1"]>,
    commits: readonly CommitFrontierAnchor[],
    observations?: readonly VerifiedRegisterObservation[],
  ): Promise<NonNullable<S3SyncData["v1"]>> {
    const ingested = advanceIngestedCommitState({ frontiers: state.writerFrontiers ?? {}, sparseSeenCommits: this.data.v1SparseSeenCommits }, commits);
    const updated = { ...state, writerFrontiers: ingested.frontiers };
    this.data.v1 = updated;
    this.data.v1SparseSeenCommits = ingested.sparseSeenCommits;
    if (observations) {
      const merged = mergeVerifiedRegisterObservations(observations, this.data.v1ProjectedHeads);
      this.data.v1ObservedRegisters = merged.observedRegisters;
      this.data.v1PendingApply = merged.pendingApply;
    }
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
    const status = this.getOperationalStatus();
    this.statusEl.setText(`S3 Sync：${status.phase} · ${repositoryHealthLabel(status)}${status.conflicts > 0 ? ` · 冲突 ${status.conflicts}` : ""}${status.outbox > 0 ? ` · Outbox ${status.outbox}` : ""}`);
  }

  private updateOperationalStatus(patch: Partial<OperationalStatus>): void {
    this.data.v1OperationalStatus = { ...this.data.v1OperationalStatus, ...patch };
  }

  private recordOperationalError(error: unknown): void {
    const candidate = error as { code?: string; status?: number };
    this.updateOperationalStatus({
      phase: "idle",
      lastError: { category: diagnosticCategory(candidate), message: this.errorMessage(error) },
    });
    new Notice(`S3 Sync：${this.errorMessage(error)}`);
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
      configProfile: {
        ...DEFAULT_SETTINGS.configProfile,
        ...(persisted?.settings?.configProfile ?? {}),
      },
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

    const selectedRepository = persisted?.repositorySelection
      ? {
        ...persisted.repositorySelection,
        writerFrontiers: {},
        writerId: "pending-durable-state",
        nextSequence: "00000000000000000001",
        previousCommitHash: null,
      }
      : undefined;
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
      v1SparseSeenCommits: persisted?.syncData?.v1SparseSeenCommits ?? {},
      v1ObservedRegisters: persisted?.syncData?.v1ObservedRegisters ?? {},
      v1PendingApply: persisted?.syncData?.v1PendingApply ?? {},
      v1LocalConcurrentRecords: persisted?.syncData?.v1LocalConcurrentRecords ?? {},
      v1PublishedReconciles: persisted?.syncData?.v1PublishedReconciles ?? [],
      v1DurableOutbox: persisted?.syncData?.v1DurableOutbox ?? [],
      v1RecoveryRecords: persisted?.syncData?.v1RecoveryRecords ?? {},
      v1ReattachRequired: persisted?.syncData?.v1ReattachRequired ?? false,
      v1OperationalStatus: persisted?.syncData?.v1OperationalStatus ?? defaultData.v1OperationalStatus,
      v1: persisted?.syncData?.v1 ?? selectedRepository,
    };
    try {
      await this.restoreV1DurableState();
    } catch (error) {
      this.data.v1ReattachRequired = true;
      this.data.v1OperationalStatus = {
        ...this.data.v1OperationalStatus,
        repositoryIdentityValid: false,
        recoveryRequired: true,
        lastError: { category: "repository-identity", message: this.errorMessage(error) },
      };
    }
  }

  private async savePluginData(): Promise<void> {
    await this.persistV1DurableState();
    const state = this.data.v1;
    const envelope: PersistedPluginData = {
      schemaVersion: 2,
      settings: this.settings,
      ...(state ? {
        repositorySelection: {
          prefix: state.prefix,
          locator: state.locator,
          repositoryId: state.repositoryId,
          descriptorHash: state.descriptorHash,
          repositoryFingerprint: state.repositoryFingerprint,
          configDir: state.configDir,
          historicalConfigDirs: [...state.historicalConfigDirs],
        },
      } : {}),
      preferences: {},
    };
    assertPluginDataContainsNoOperationalState(envelope);
    await this.saveData(envelope);
  }

  private async persistV1DurableState(): Promise<void> {
    const state = this.data.v1;
    if (!state) return;
    if (typeof state.repositoryFingerprint !== "string" || !state.locator
      || typeof state.configDir !== "string" || !Array.isArray(state.historicalConfigDirs)) return;
    const store = await this.v1DurableStore(state);
    const identity = repositoryDurablePayload(state) as Record<string, StateJsonValue>;
    const projectionPaths = new Set([...Object.keys(this.data.v1ProjectedHeads), ...Object.keys(this.data.files), ...Object.keys(this.data.v1VaultGenerations)]);
    const projections = Object.fromEntries([...projectionPaths].sort().map((path) => [path, {
      projectedHeads: [...(this.data.v1ProjectedHeads[path] ?? [])],
      projectedValueHash: this.data.files[path]?.hash ?? null,
      generation: this.data.v1VaultGenerations[path] ?? 0,
    }]));
    const payload = JSON.parse(JSON.stringify({
      ...identity,
      dirtyIntents: this.data.v1DirtyIntents,
      projections,
      outboxRefs: this.data.v1DurableOutbox.map(durableOutboxReference),
      durableOutbox: this.data.v1DurableOutbox,
      localConcurrentRecords: this.data.v1LocalConcurrentRecords,
      publishedReconciles: this.data.v1PublishedReconciles,
      recoveryRecords: this.data.v1RecoveryRecords,
      sparseSeenCommits: this.data.v1SparseSeenCommits,
      observedRegisters: this.data.v1ObservedRegisters,
      pendingApply: this.data.v1PendingApply,
      projectedHeads: this.data.v1ProjectedHeads,
      vaultEvents: this.data.v1VaultEvents,
      vaultGenerations: this.data.v1VaultGenerations,
      recoveryCandidates: this.data.v1RecoveryCandidates,
      applyJournals: this.data.v1ApplyJournals,
      files: this.data.files,
      conflicts: this.data.conflicts,
      operationalStatus: this.data.v1OperationalStatus,
      reattachRequired: this.data.v1ReattachRequired,
    })) as StateJsonValue;
    await writeRepositoryStateTransaction(store, payload);
  }

  private async restoreV1DurableState(): Promise<void> {
    const state = this.data.v1;
    if (!state || typeof state.repositoryFingerprint !== "string" || !state.locator) return;
    const snapshot = await (await this.v1DurableStore(state)).load();
    if (!snapshot) {
      this.data.v1ReattachRequired = true;
      return;
    }
    const durable = validateRepositoryStatePayload(snapshot.payload);
    if (durable.repositoryFingerprint !== state.repositoryFingerprint) throw new Error("durable state repository fingerprint mismatch");
    const payload = snapshot.payload as Record<string, StateJsonValue>;
    this.data.v1 = {
      ...state,
      writerId: durable.writerId,
      nextSequence: durable.nextSequence,
      previousCommitHash: durable.previousCommitHash,
      writerFrontiers: durable.writerFrontiers,
    };
    this.data.v1SparseSeenCommits = clonePayload(payload.sparseSeenCommits, {});
    this.data.v1ObservedRegisters = clonePayload(payload.observedRegisters, {});
    this.data.v1PendingApply = clonePayload(payload.pendingApply, {});
    this.data.v1DirtyIntents = clonePayload(payload.dirtyIntents, {});
    this.data.v1ProjectedHeads = clonePayload(payload.projectedHeads, {});
    this.data.v1VaultEvents = clonePayload(payload.vaultEvents, []);
    this.data.v1VaultGenerations = clonePayload(payload.vaultGenerations, {});
    this.data.v1RecoveryCandidates = clonePayload(payload.recoveryCandidates, {});
    this.data.v1ApplyJournals = clonePayload(payload.applyJournals, []);
    this.data.v1LocalConcurrentRecords = clonePayload(payload.localConcurrentRecords, {});
    this.data.v1PublishedReconciles = clonePayload(payload.publishedReconciles, []);
    this.data.v1DurableOutbox = clonePayload(payload.durableOutbox, []);
    this.data.v1RecoveryRecords = clonePayload(payload.recoveryRecords, {});
    this.data.files = clonePayload(payload.files, {});
    this.data.conflicts = clonePayload(payload.conflicts, {});
    this.data.v1OperationalStatus = clonePayload(payload.operationalStatus, this.data.v1OperationalStatus);
    this.data.v1ReattachRequired = clonePayload(payload.reattachRequired, false);
  }

  private async v1DurableStore(state: NonNullable<S3SyncData["v1"]>): Promise<DurableStateStore<StateJsonValue>> {
    if (this.v1DurableState?.fingerprint !== state.repositoryFingerprint) {
      const files = await openRepositoryStateFiles(this.app.vault.adapter, this.app.vault.configDir, state.repositoryId);
      this.v1DurableState = { fingerprint: state.repositoryFingerprint, store: new DurableStateStore<StateJsonValue>(files) };
    }
    return this.v1DurableState.store;
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
    state = await this.persistObservedRemoteState(state, pulled.acceptedCommits, pulled.observations);
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
      this.data.v1ProjectedHeads[conflict.path] = [...candidate.heads];
      delete this.data.v1PendingApply[conflict.path];
    } else {
      const capture = await captureStableVaultFile(this.app.vault, conflict.path);
      if (!capture || capture.hash !== conflict.localHash) throw new Error("local conflict content changed; refresh before resolving");
      const reservation = reserveWriterCommit(state);
      const published = await service.publishVaultPut({ repositoryId: state.repositoryId, descriptorHash: state.descriptorHash, writerId: state.writerId, sequence: reservation.sequence, previousCommitHash: reservation.previousCommitHash, createdAt: new Date().toISOString(), clientVersion: this.manifest.version, path: conflict.path, parents: remote.heads, capture, writerFrontiers: state.writerFrontiers });
      const commitHash = published.hash;
      this.data.v1 = { ...state, ...recordPublishedWriterCommit(state, commitHash, () => crypto.randomUUID()), writerFrontiers: advanceWriterFrontiers(state.writerFrontiers, [published]) };
      await this.savePluginData();
      this.data.files[conflict.path] = { hash: capture.hash, size: capture.size, updatedAt: new Date().toISOString() };
      delete this.data.v1PendingApply[conflict.path];
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

function durableOutboxReference(entry: DurableOutboxEntry) {
  return {
    id: entry.id,
    writerId: entry.writerId,
    sequence: entry.sequence,
    commitHash: entry.commitHash,
    stagedPath: entry.objects.at(-1)?.contentRef ?? "missing",
    captureGeneration: entry.captureGeneration,
  };
}

function clonePayload<T>(value: StateJsonValue | undefined, fallback: T): T {
  return value === undefined ? fallback : JSON.parse(JSON.stringify(value)) as T;
}
