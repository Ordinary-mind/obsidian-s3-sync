import { FileSystemAdapter, Notice, Platform, Plugin, TFile, apiVersion, normalizePath } from "obsidian";
import { ConflictModal } from "./conflict-modal";
import { createDefaultData, DEFAULT_SETTINGS } from "./defaults";
import { S3SyncSettingTab } from "./settings-tab";
import { runDesktopRuntimeContract } from "./runtime-contract";
import { RuntimeContractModal } from "./runtime-contract-modal";
import { V1RepositoryService } from "./v1-service";
import type { S3SyncData, S3SyncSettings } from "./types";
import { ensureParentFolder, getTFile, isIgnored, parseIgnorePatterns, toArrayBuffer } from "./utils";
import { resolveEffectivePrefix } from "./connection-prefix";
import { captureStableVaultFile, captureStableVaultFileToStaging } from "./vault-stable-capture";
import { reserveWriterCommit } from "../core/writer-session";
import { decideResolvedRemotePut } from "../core/pull-decision";
import { conflictId } from "../core/conflict-id";
import { conflictCopyContentMatches, conflictVersionCopyPath } from "../core/conflict-copy";
import { findCaseAliasConflicts, findStructuralConflicts } from "../core/structural-conflict";
import { vaultPathCaseFoldKey } from "../core/path";
import { mayApplyRemoteWithEditorIntent } from "../core/editor-latch";
import { sha256Hex } from "../protocol/hash";
import { bindRootDeletePredecessor, bindVaultEventsAfterPublication, clearVaultEventsThroughGeneration, latestVaultEvent, mergeVaultEventsAfterPublication, recordVaultEvent } from "../core/vault-event";
import { isVaultPathExcluded, localStateRoot } from "../core/scope";
import { createRepositoryLocator, type RepositoryLocator } from "../core/locator";
import { assertPersistedRepositoryBinding, createPersistedRepositoryBinding } from "../core/repository-binding";
import type { CommitFrontierAnchor } from "../core/commit-frontier";
import { DurableStateStore, type StateJsonValue } from "../core/durable-state";
import {
  beginDurableOutboxPublicationTransaction,
  completePublishedConfigOutboxTransaction,
  completePublishedVaultOutboxTransaction,
  confirmDurableOutboxPublishedTransaction,
  confirmTerminalDurableOutboxPublishedTransaction,
  failDurableOutboxPublicationTransaction,
  freezeDurableOutboxStateTransaction,
  validateRepositoryStatePayload,
} from "../core/repository-state-transaction";
import { advanceIngestedCommitState } from "../core/ingested-state";
import { mergeVerifiedRegisterObservations, type VerifiedRegisterObservation } from "../core/remote-merge-state";
import {
  assertPluginDataContainsNoOperationalState,
  effectivePersistedRepositoryPrefix,
} from "../core/plugin-data";
import {
  freezeDurableOutbox,
  nextDurableOutbox,
  publishedReconcileBlocksAutomaticApply,
  withDurableOutboxReplayStage,
  type DurableOutboxEntry,
  type VerifiedTerminalOutboxProof,
} from "../core/durable-outbox";
import { localConcurrentRecordBlocksAutomaticWork } from "../core/local-concurrent-resolution";
import { SyncDashboardModal } from "./sync-dashboard-modal";
import { buildRedactedDiagnosticBundle } from "../core/diagnostic-bundle";
import { DiagnosticError, diagnosticCategory, type SyncDiagnosticCategory } from "../core/diagnostics";
import {
  logSafeError,
  safeErrorMessage,
  safeErrorRecord,
  safeGenericErrorReport,
  safeSyncErrorReport,
  withConnectionFlowStage,
  withLocalPersistenceStep,
  withSyncFlowStage,
  type SyncFlowStage,
} from "../core/safe-error";
import {
  derivePathDecision,
  hasManualRecoveryBlocker,
  mayRunMutatingSync,
  operationalStatusBarText,
  summarizeRepositorySpace,
  type OperationalStatus,
  type PathDecisionRecord,
  type PreviewRemoteState,
} from "../core/operational-status";
import { retryDelayMs } from "../core/backoff";
import { remoteAuditFailureProgress } from "../core/remote-audit";
import { ConfigCenterModal } from "./config-center-modal";
import type {
  ConfigApplyOutcome,
  ConfigApplyPreview,
  ConfigApplyTrustConfirmation,
  ConfigCenterSnapshot,
  ConfigPublicationConfirmation,
  ConfigTreeSourceView,
  PersistedConfigSyncState,
} from "./config-center-types";
import { createDefaultConfigSyncState } from "./config-center-types";
import { createConfigWorkspaceRuntime, buildRemoteConfigSources, captureLocalConfigSource, inventoryManifestMap, stageConfigTreeBytes, treeManagedItems, type ConfigWorkspaceRuntime } from "./config-workspace";
import { buildMultiSourceConfigMerge, configTrustRequirements, deriveConfigRegisterUiState, summarizeConfigPluginChanges } from "../core/config-ui-state";
import { diffManagedConfigItems } from "../core/config-diff";
import type { ManagedConfigItem } from "../core/config-snapshot-builder";
import { validateConfigProfile } from "../core/config-profile";
import type { ConfigProfile } from "../core/types";
import { SafeConfigBatchApplicator, configBatchPlanHash, type ConfigBatchOperation, type ConfigBatchPlan, type ConfigBatchResult } from "../core/config-batch-apply";
import { captureConfigDirtyIntent, configPublicationParents } from "../core/config-causality";
import { encodeCommunityPluginIds, mergePortableEnabledPluginIds } from "../core/community-plugins";
import { assessConfigTreeCompatibility } from "../core/config-compatibility";
import { buildConfigTreeObject, type ProtocolConfigTree } from "../core/config-tree";
import { buildConfigSnapshotPublishEnvelope } from "../core/config-publish-envelope";
import type { RepositoryOperationOwner } from "../core/repository-operation-lock";
import { buildVaultDeleteControlEnvelope, buildVaultPutControlEnvelope } from "../core/vault-publish-envelope";
import { ImmutableContentStaging } from "../core/content-staging";
import { NodeContentStagingAdapter } from "../adapters/node-content-staging-adapter";
import type { StableStreamCaptureResult } from "../core/streaming-capture";
import { BoundedExecutor } from "../core/bounded-executor";
import { NodeLocalFileAdapter } from "../adapters/node-local-file-adapter";
import { SafeLocalApplicator, type BoundApplyPlan, type SafeApplyJournal } from "../core/safe-apply";
import type { RecoveryRecord } from "../core/recovery-record";
import { repositoryPerformanceProfile } from "../core/performance-profile";
import type { RemoteVaultConflictCandidate } from "../core/remote-vault-conflict";
import { showCopyableErrorNotice, showCopyableNotice } from "./copyable-notice";
import {
  SyncPreflightError,
  syncPreflightBlocker,
  verifiedRepositoryOperationalStatus,
  verifiedTerminalOutboxOperationalStatus,
  type SyncPreflightEvidence,
} from "../core/sync-preflight";
import { AutoSyncScheduler } from "./auto-sync-scheduler";
import { RepositoryOperationRuntime } from "./repository-operation-runtime";
import { decodePluginData, encodePluginData } from "./plugin-data-codec";
import { RepositoryStateRuntime, type RepositoryStateRestoreResult } from "./repository-state-runtime";
import {
  ConnectionController,
  type ConnectionSettingsInput,
  type DiscoveredRepository,
} from "./connection-controller";
import { VaultEventTracker } from "./vault-event-tracker";
import { compareUtf8 } from "../protocol/utf8";

type V1OperationResult =
  | { status: "success" }
  | { status: "blocked"; conflicts: number; pending: number }
  | { status: "failed"; error: unknown };
type V1VaultPullDiagnostics = Awaited<ReturnType<V1RepositoryService["listResolvedVaultPutsWithDiagnostics"]>>;
interface V1PullCounts { created: number; updated: number; deleted: number; skipped: number }

export default class S3SyncPlugin extends Plugin {
  settings: S3SyncSettings = { ...DEFAULT_SETTINGS };
  data: S3SyncData = createDefaultData();

  private retryTimer: number | null = null;
  private autoSyncScheduler: AutoSyncScheduler | undefined;
  private statusEl: HTMLElement | null = null;
  private readonly runtimeContractSessionId = crypto.randomUUID();
  private editorChangeObserved = false;
  private causalStatePersistence = Promise.resolve();
  private readonly v1ApplyOperations = new Map<string, string>();
  private readonly repositoryState = new RepositoryStateRuntime(this.app.vault.adapter, this.app.vault.configDir);
  private readonly repositoryOperation = new RepositoryOperationRuntime();
  private readonly vaultHashExecutor = new BoundedExecutor(repositoryPerformanceProfile.hashConcurrency);
  private readonly vaultEvents = new VaultEventTracker({
    getData: () => this.data,
    isManagedPath: (path) => this.isV1ManagedVaultPath(path),
    capturePathHash: (path) => this.captureVaultFileHash(path),
    currentApplyOperation: (path) => this.v1ApplyOperations.get(path),
    persistSoon: () => this.queueCausalStatePersistence(),
    notifyChange: () => this.autoSyncScheduler?.notifyChange(),
  });
  private readonly connectionController = new ConnectionController({
    configDir: this.app.vault.configDir,
    vaultName: this.app.vault.getName(),
    getSettings: () => this.settings,
    setSettings: (settings) => { this.settings = settings; },
    getData: () => this.data,
    setData: (data) => { this.data = data; },
    createService: (settings, prefix) => this.createRepositoryService(settings, prefix),
    stopAndFlush: async () => {
      this.stopSchedulingAndFlush();
      await this.causalStatePersistence;
    },
    persistRepositoryState: () => this.persistV1DurableState(),
    clearRepositoryState: () => this.repositoryState.clear(),
    createUnboundData: () => createDefaultData(),
    activateRepository: (locator, repository) => this.activateRepository(locator, repository),
    savePluginData: () => this.savePluginData(),
    markRepositoryVerified: () => this.markRepositoryVerified(),
  });

  async onload(): Promise<void> {
    await this.loadPluginData();
    this.autoSyncScheduler = new AutoSyncScheduler(() => this.runV1SyncRound(true), {
      onError: (error) => this.reportBackgroundError("自动同步调度失败", error, "auto-sync-scheduler"),
    });
    this.autoSyncScheduler.setEnabled(this.settings.autoSync);

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addEventListener("click", () => new SyncDashboardModal(this).open());
    this.updateStatus();

    this.addRibbonIcon("refresh-cw", "S3 Sync：同步", () => void this.runManualSyncV1());

    this.addCommand({
      id: "s3-sync-dashboard",
      name: "S3 Sync：状态与检查",
      callback: () => new SyncDashboardModal(this).open(),
    });

    this.addCommand({
      id: "s3-sync-now",
      name: "S3 Sync：同步",
      callback: () => void this.runManualSyncV1(),
    });

    this.addCommand({
      id: "s3-sync-inspect-and-pull",
      name: "S3 Sync：检查并拉取",
      callback: () => void this.pullMissingFilesV1(),
    });

    this.addSettingTab(new S3SyncSettingTab(this.app, this));
    this.registerEvent(this.app.workspace.on("editor-change", (editor, info) => {
      this.runBackgroundAction("编辑器事件处理失败", "editor-change-event", () => {
        this.editorChangeObserved = true;
        const file = info.file;
        if (!file || !this.data.v1) return;
        const path = normalizePath(file.path);
        if (!this.isV1ManagedVaultPath(path)) return;
        const editorContentHash = sha256Hex(new TextEncoder().encode(editor.getValue()));
        this.vaultEvents.recordEditorChange(path, editorContentHash);
      });
    }));
    this.registerV1VaultEvents();
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") this.stopSchedulingAndFlush();
      else {
        this.autoSyncScheduler?.resume(false);
        this.resumeV1RetrySchedule();
      }
    });
    this.autoSyncScheduler.resume(!!this.data.v1);
    this.resumeV1RetrySchedule();
  }

  onunload(): void {
    this.autoSyncScheduler?.stop();
    this.stopSchedulingAndFlush();
    this.repositoryOperation.dispose();
  }

  private async saveSettings(): Promise<void> {
    this.autoSyncScheduler?.setEnabled(this.settings.autoSync, this.settings.autoSync && !!this.data.v1);
    if (!this.settings.autoSync) this.cancelV1Retry(true);
    await this.savePluginData();
  }

  async setAutoSyncEnabled(enabled: boolean): Promise<void> {
    await this.persistSettingsMutation(() => {
      this.settings.autoSync = enabled;
    });
  }

  async setIgnoredPatterns(ignoredPatterns: string): Promise<void> {
    await this.persistSettingsMutation(() => {
      this.settings.ignoredPatterns = ignoredPatterns;
    });
  }

  async testAndApplyConnectionSettings(input: ConnectionSettingsInput): Promise<string> {
    try {
      this.beginRepositoryOperation("vault");
    } catch (error) {
      throw withConnectionFlowStage("operation-lock", error);
    }
    try {
      return await this.connectionController.testAndApply(input);
    } finally {
      this.endRepositoryOperation("vault");
      this.autoSyncScheduler?.setEnabled(this.settings.autoSync);
      this.autoSyncScheduler?.resume(false);
      this.resumeV1RetrySchedule();
    }
  }

  async saveSyncData(): Promise<void> {
    await this.savePluginData();
    this.updateStatus();
  }

  async resolveConflict(conflictId: string, mode: "local" | "remote", candidateVersionId?: string): Promise<void> {
    this.beginRepositoryOperation("vault");
    try {
      const conflict = this.data.conflicts[conflictId];
      if (!conflict) throw new Error("conflict no longer exists");
      await this.resolveV1Conflict(conflict, mode, candidateVersionId);
    } finally {
      this.endRepositoryOperation("vault");
    }
  }

  async openFile(path: string): Promise<void> {
    const file = getTFile(this.app.vault, path);
    if (!file) {
      throw new DiagnosticError(
        "VAULT_FILE_NOT_FOUND",
        "local-path",
        "the requested Vault file does not exist or has moved",
      );
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  getEffectivePrefix(): string {
    return effectivePersistedRepositoryPrefix(
      this.data.v1?.locator.normalizedPrefix,
      resolveEffectivePrefix(this.settings.prefix, this.app.vault.getName()),
    );
  }

  getOperationalStatus(): OperationalStatus {
    const base = this.data.v1OperationalStatus;
    const recoveryRecords = Object.values(this.data.v1RecoveryRecords);
    const strandedApplyJournal = this.data.v1ApplyJournals.some((journal) => this.v1ApplyOperations.get(journal.path) !== journal.operationId);
    const recoveryBlockers = [...base.recoveryBlockers];
    if (strandedApplyJournal || this.data.v1ApplyJournals.some((journal) => journal.state === "recovery-required")) {
      recoveryBlockers.push({
        code: "vault-apply",
        source: "vault-apply-journal",
        disposition: "manual",
        message: "存在未完成的 Vault 安全应用；原文件前像已保留。",
      });
    }
    if (this.data.v1ConfigSync.status === "recovery-required") recoveryBlockers.push({
      code: "config-apply",
      source: "config-apply-journal",
      disposition: "manual",
      message: "存在未完成的配置批次恢复。",
    });
    if (this.data.v1DurableOutbox.some((entry) => entry.state === "integrity-error" || entry.state === "recovery-required")) {
      recoveryBlockers.push({
        code: "durable-outbox",
        source: "outbox",
        disposition: "automatic",
        message: "旧上传将在下一次同步中从本地暂存或远端副本自动恢复。",
      });
    }
    const uniqueRecoveryBlockers = [...new Map(recoveryBlockers.map((blocker) => [`${blocker.code}:${blocker.source}`, blocker])).values()];
    const manualRecovery = uniqueRecoveryBlockers.some((blocker) => blocker.disposition === "manual");
    const automaticRecovery = uniqueRecoveryBlockers.some((blocker) => blocker.disposition === "automatic");
    const idlePhase = !this.repositoryOperation.isRunning();
    return {
      ...base,
      phase: idlePhase && (manualRecovery || !base.repositoryIdentityValid)
        ? "read-only"
        : idlePhase && automaticRecovery && base.phase === "idle" ? "recovering" : base.phase,
      pendingApply: Object.keys(this.data.v1PendingApply).length,
      outbox: this.data.v1DurableOutbox.filter((entry) => entry.state !== "published").length,
      localConcurrentRecords: Object.keys(this.data.v1LocalConcurrentRecords).length,
      recoveryFiles: recoveryRecords.filter((record) => record.cleanupState !== "cleaned").length,
      postCaptureEdits: recoveryRecords.filter((record) => record.postCaptureEdit).length,
      commitGaps: Object.keys(this.data.v1SparseSeenCommits).length,
      conflicts: Object.values(this.data.conflicts).filter((conflict) => !conflict.resolved).length,
      recoveryBlockers: uniqueRecoveryBlockers,
      repositoryIdentityValid: base.repositoryIdentityValid,
    };
  }

  canAttemptV1Sync(): boolean {
    return !!this.data.v1 && syncPreflightBlocker(this.v1SyncPreflightEvidence()) === undefined;
  }

  private v1SyncPreflightEvidence(): SyncPreflightEvidence {
    return { status: this.getOperationalStatus() };
  }

  private assertV1SyncPreflight(): void {
    const blocker = syncPreflightBlocker(this.v1SyncPreflightEvidence());
    if (blocker) throw new SyncPreflightError(blocker);
  }

  private assertV1InspectionPreflight(): void {
    const blocker = syncPreflightBlocker(this.v1SyncPreflightEvidence());
    if (blocker === "repository-state-recovery" || blocker === "repository-stopped") {
      throw new SyncPreflightError(blocker);
    }
  }

  private recoverVerifiedRepositoryIdentityLock(): void {
    if (!this.markRepositoryVerified()) return;
    this.queueCausalStatePersistence();
  }

  private markRepositoryVerified(): boolean {
    const current = this.data.v1OperationalStatus;
    const recovered = verifiedRepositoryOperationalStatus(current);
    if (recovered === current) return false;
    this.data.v1OperationalStatus = recovered;
    this.updateStatus();
    return true;
  }

  openConflictModal(): void { new ConflictModal(this).open(); }

  openConfigCenter(): void { new ConfigCenterModal(this).open(); }

  isConfigOperationInProgress(): boolean { return this.repositoryOperation.isRunning(); }

  private beginRepositoryOperation(owner: RepositoryOperationOwner): void {
    if (this.repositoryOperation.tryAcquire(owner)) return;
    throw new Error(this.repositoryOperation.currentOwner() === "config"
      ? "已有配置操作正在运行"
      : "已有 Vault 仓库操作正在运行");
  }

  private endRepositoryOperation(owner: RepositoryOperationOwner): void {
    this.repositoryOperation.release(owner);
  }

  private createRepositoryService(settings = this.settings, prefix = settings.prefix): V1RepositoryService {
    return new V1RepositoryService(settings, prefix, this.repositoryOperation.currentSignal());
  }

  getConfigSyncState(): PersistedConfigSyncState {
    return structuredClone(this.data.v1ConfigSync);
  }

  async updateConfigProfile(profile: ConfigProfile): Promise<void> {
    this.beginRepositoryOperation("config");
    try {
      await this.updateConfigProfileLocked(profile);
    } finally {
      this.endRepositoryOperation("config");
    }
  }

  private async updateConfigProfileLocked(profile: ConfigProfile): Promise<void> {
    const next = structuredClone(profile);
    const violations = validateConfigProfile(next, this.manifest.id);
    if (violations.length > 0) throw new Error(`ConfigProfile 无效：${violations.join(", ")}`);
    if (JSON.stringify(next) === JSON.stringify(this.settings.configProfile)) return;
    const generation = this.data.v1ConfigSync.generation + 1;
    const dirtyIntent = this.data.v1ConfigSync.dirtyIntent
      ?? (this.data.v1ConfigSync.projectedTreeHash !== null
        ? captureConfigDirtyIntent({
          projectedHeads: this.data.v1ConfigSync.projectedHeads,
          projectedTreeHash: this.data.v1ConfigSync.projectedTreeHash,
          generation,
        })
        : undefined);
    await this.persistSettingsMutation(() => {
      this.settings.configProfile = next;
      this.data.v1ConfigSync = {
        ...this.data.v1ConfigSync,
        generation,
        status: this.data.v1 ? "local-changes" : "unbound",
        ...(dirtyIntent ? { dirtyIntent } : {}),
        lastError: undefined,
      };
    });
  }

  private async persistSettingsMutation(mutate: () => void): Promise<void> {
    const previousSettings = structuredClone(this.settings);
    const previousConfigSync = structuredClone(this.data.v1ConfigSync);
    const previousOperationalStatus = structuredClone(this.data.v1OperationalStatus);
    try {
      mutate();
      await this.saveSettings();
    } catch (error) {
      this.settings = previousSettings;
      this.data.v1ConfigSync = previousConfigSync;
      this.data.v1OperationalStatus = previousOperationalStatus;
      this.autoSyncScheduler?.setEnabled(previousSettings.autoSync);
      this.autoSyncScheduler?.resume(false);
      this.resumeV1RetrySchedule();
      this.updateStatus();
      throw error;
    }
  }

  async loadConfigCenterSnapshot(): Promise<ConfigCenterSnapshot> {
    this.beginRepositoryOperation("config");
    try {
      return await this.loadConfigCenterSnapshotLocked();
    } finally {
      this.endRepositoryOperation("config");
    }
  }

  private async loadConfigCenterSnapshotLocked(): Promise<ConfigCenterSnapshot> {
    const selected = this.data.v1;
    if (!selected) {
      const state = deriveConfigRegisterUiState({
        repositoryBound: false,
        remoteDisposition: "empty",
      });
      this.data.v1ConfigSync = { ...this.data.v1ConfigSync, status: state.status, lastError: undefined };
      return emptyConfigCenterSnapshot(state, this.data.v1ConfigSync);
    }
    let localSource: ConfigTreeSourceView | undefined;
    let inventory: ConfigCenterSnapshot["inventory"] = [];
    let localEnabled: string[] = [];
    let runtime: ConfigWorkspaceRuntime | undefined;
    try {
      runtime = this.configWorkspaceRuntime(selected);
      await this.assertV1RepositoryBinding(selected);
      await this.drainDurableOutbox(selected, runtime.staging);
      await this.reconcilePendingPublishedVaultMutations(this.data.v1 ?? selected);
      await this.finalizePendingConfigPublication(selected, runtime);
      const previousItems = persistedConfigTreeItems(this.data.v1ConfigSync.projectedTree);
      const localCapture = await captureLocalConfigSource({
        runtime,
        profile: this.settings.configProfile,
        previousItems,
        repositoryId: selected.repositoryId,
        descriptorHash: selected.descriptorHash,
        configDir: selected.configDir,
        historicalConfigDirs: selected.historicalConfigDirs,
        currentAppVersion: apiVersion,
        isDesktop: Platform.isDesktop,
        syncPluginId: this.manifest.id,
        quietWindow: () => delay(500),
      });
      inventory = localCapture.inventory;
      if (localCapture.result.status !== "captured") {
        const message = `本地配置扫描未完成：${localCapture.result.reason}${localCapture.result.paths?.length ? `（${localCapture.result.paths.join(", ")}）` : ""}`;
        const error = localCapture.result.error ?? new DiagnosticError(
          "CONFIG_LOCAL_SCAN_INCOMPLETE",
          "local-path",
          message,
        );
        const state = deriveConfigRegisterUiState({
          repositoryBound: true,
          remoteDisposition: "empty",
          loadError: message,
        });
        this.recordConfigUiState(state.status, message, runtime.recoveryLocation);
        return {
          ...emptyConfigCenterSnapshot(state, this.data.v1ConfigSync),
          inventory,
          recoveryLocation: runtime.recoveryLocation,
          errorReport: safeGenericErrorReport(error, "config-local-scan"),
        };
      }
      if (!localCapture.source) throw new Error("本地 ConfigTree 视图缺失");
      localSource = localCapture.source;
      localEnabled = [...localCapture.result.allEnabledPluginIds];

      if (this.data.v1ConfigSync.projectedTreeHash !== null
        && localSource.treeHash !== this.data.v1ConfigSync.projectedTreeHash
        && !this.data.v1ConfigSync.dirtyIntent) {
        const generation = this.data.v1ConfigSync.generation + 1;
        this.data.v1ConfigSync = {
          ...this.data.v1ConfigSync,
          generation,
          dirtyIntent: captureConfigDirtyIntent({
            projectedHeads: this.data.v1ConfigSync.projectedHeads,
            projectedTreeHash: this.data.v1ConfigSync.projectedTreeHash,
            generation,
          }),
        };
      }

      const activeState = this.data.v1;
      if (!activeState || activeState.repositoryFingerprint !== selected.repositoryFingerprint) {
        throw new Error("仓库绑定在配置加载期间发生变化");
      }
      const service = this.createRepositoryService(this.settings, activeState.locator.normalizedPrefix);
      const inspection = await service.inspectConfigRegister(activeState.repositoryId, activeState.descriptorHash);
      const current = await this.persistObservedRemoteState(activeState, inspection.acceptedCommits, inspection.observations);
      const completeHeads = inspection.heads.filter((head) => head.blockedDependencies.length === 0);
      const remote = await buildRemoteConfigSources({
        runtime,
        heads: completeHeads,
        localItems: localSource.items,
        inventory,
        allLocalEnabledPluginIds: localEnabled,
        currentAppVersion: apiVersion,
        isDesktop: Platform.isDesktop,
        syncPluginId: this.manifest.id,
      });
      const resolved = inspection.disposition === "resolved" && remote.length === 1 ? remote[0] : undefined;
      if (resolved && resolved.treeHash === localSource.treeHash
        && (this.data.v1ConfigSync.projectedTreeHash !== resolved.treeHash
          || !sameHeads(this.data.v1ConfigSync.projectedHeads, inspection.headVersionIds)
          || this.data.v1ConfigSync.dirtyIntent !== undefined)) {
        this.data.v1ConfigSync = {
          ...this.data.v1ConfigSync,
          projectedHeads: [...inspection.headVersionIds],
          projectedTreeHash: resolved.treeHash,
          projectedTree: structuredClone(resolved.tree),
          generation: Math.max(1, this.data.v1ConfigSync.generation + 1),
          dirtyIntent: undefined,
        };
      }
      const compatible = resolved?.compatibility.status !== "incompatible";
      const initialLocalConflict = resolved !== undefined
        && this.data.v1ConfigSync.projectedTreeHash === null
        && (this.data.v1ConfigSync.generation > 0
          || localSource.items.length > 0
          || localSource.tree.enabledCommunityPlugins.length > 0)
        && resolved.treeHash !== localSource.treeHash;
      const applyFailure = this.data.v1ConfigSync.status === "recovery-required"
        ? "recovery-required"
        : this.data.v1ConfigSync.status === "apply-failed" ? "rolled-back" : undefined;
      const state = deriveConfigRegisterUiState({
        repositoryBound: true,
        remoteDisposition: initialLocalConflict ? "conflict" : inspection.disposition,
        remoteHeads: inspection.headVersionIds,
        pendingVersions: inspection.pendingVersionIds,
        invalidVersions: inspection.invalidVersionIds,
        localTreeHash: localSource.treeHash,
        projectedTreeHash: this.data.v1ConfigSync.generation > 0 ? this.data.v1ConfigSync.projectedTreeHash : undefined,
        compatible,
        applyFailure,
      });
      const blockedDetails = [
        ...inspection.blockedCommitKeys.map((entry) => `${entry.key}: ${this.errorMessage(entry.reason)}`),
        ...inspection.heads.flatMap((head) => head.blockedDependencies.map((entry) => `${entry.path}: ${this.errorMessage(entry.reason)}`)),
      ];
      this.data.v1 = current;
      this.recordConfigUiState(state.status, state.status === "load-failed" ? state.message : undefined, runtime.recoveryLocation);
      this.queueCausalStatePersistence();
      return {
        state,
        local: localSource,
        remote,
        ...(resolved ? { resolvedRemoteId: resolved.id } : {}),
        diff: resolved ? diffManagedConfigItems(localSource.items, resolved.items) : [],
        inventory,
        allLocalEnabledPluginIds: localEnabled,
        projectedHeads: [...this.data.v1ConfigSync.projectedHeads],
        projectedTreeHash: this.data.v1ConfigSync.projectedTreeHash,
        recoveryLocation: runtime.recoveryLocation,
        blockedDetails,
      };
    } catch (error) {
      const message = this.errorMessage(error);
      const recoveryLocation = runtime?.recoveryLocation
        ?? this.data.v1ConfigSync.recoveryLocation
        ?? "尚未建立仓库恢复位置";
      const state = deriveConfigRegisterUiState({
        repositoryBound: true,
        remoteDisposition: "empty",
        loadError: message,
      });
      this.recordConfigUiState("load-failed", message, runtime?.recoveryLocation);
      this.queueCausalStatePersistence();
      return {
        ...emptyConfigCenterSnapshot(state, this.data.v1ConfigSync),
        ...(localSource ? { local: localSource } : {}),
        inventory,
        allLocalEnabledPluginIds: localEnabled,
        recoveryLocation,
        errorReport: safeGenericErrorReport(error, "config-center-load"),
      };
    }
  }

  buildConfigMergeSource(input: {
    snapshot: ConfigCenterSnapshot;
    selections: Record<string, string | "stop-managing">;
    profileSourceId: string;
    enabledSourceId: string;
  }): ConfigTreeSourceView {
    const state = this.data.v1;
    if (!state || !input.snapshot.local || input.snapshot.state.status !== "conflict") {
      throw new Error("配置合并需要当前冲突快照");
    }
    const sources = [input.snapshot.local, ...input.snapshot.remote];
    const merged = buildMultiSourceConfigMerge({
      sources: sources.map((source) => ({
        id: source.id,
        profile: source.tree.profile,
        enabledCommunityPlugins: source.tree.enabledCommunityPlugins,
        items: source.items,
      })),
      selections: input.selections,
      profileSourceId: input.profileSourceId,
      enabledSourceId: input.enabledSourceId,
      syncPluginId: this.manifest.id,
    });
    const byId = new Map(sources.map((source) => [source.id, source]));
    const bytesByPath = new Map<string, Uint8Array>();
    for (const item of merged.items) {
      if (item.kind !== "put") continue;
      const sourceId = input.selections[item.path];
      const bytes = sourceId && sourceId !== "stop-managing" ? byId.get(sourceId)?.bytesByPath.get(item.path) : undefined;
      if (!bytes) throw new Error(`合并候选缺少已验证字节：${item.path}`);
      bytesByPath.set(item.path, new Uint8Array(bytes));
    }
    const tree: ProtocolConfigTree = {
      protocol: 1,
      repositoryId: state.repositoryId,
      descriptorHash: state.descriptorHash,
      profile: { schema: 1, ...structuredClone(merged.profile), minimumTargetAppVersion: merged.profile.minimumTargetAppVersion! },
      enabledCommunityPlugins: [...merged.enabledCommunityPlugins],
      items: merged.items.map((item) => item.kind === "delete"
        ? { path: item.path, kind: "delete" }
        : { path: item.path, kind: "put", blobHash: item.hash, size: item.size }),
    };
    const sizes = new Map(merged.items.filter((item): item is Extract<ManagedConfigItem, { kind: "put" }> => item.kind === "put")
      .map((item) => [item.hash, item.size]));
    const treeHash = buildConfigTreeObject("", tree, {
      configDir: state.configDir,
      historicalConfigDirs: state.historicalConfigDirs,
    }, sizes).hash;
    const manifestBytes = new Map<string, Uint8Array>();
    for (const pluginId of tree.profile.pluginPackages) {
      const path = `plugins/${pluginId}/manifest.json`;
      const bytes = bytesByPath.get(path);
      if (bytes) manifestBytes.set(path, bytes);
    }
    const compatibility = assessConfigTreeCompatibility({
      tree: { profile: tree.profile, enabledCommunityPlugins: tree.enabledCommunityPlugins, items: merged.items },
      currentAppVersion: apiVersion,
      isDesktop: Platform.isDesktop,
      syncPluginId: this.manifest.id,
      stagedManifestBytes: manifestBytes,
      localPluginManifests: inventoryManifestMap(input.snapshot.inventory),
      localPluginDirectories: input.snapshot.inventory.map((entry) => entry.directoryId),
      localEnabledPluginIds: input.snapshot.allLocalEnabledPluginIds,
    });
    const diff = diffManagedConfigItems(input.snapshot.local.items, merged.items);
    const writerIds = [...new Set(input.snapshot.remote.flatMap((source) => source.writerIds))].sort(compareUtf8);
    return {
      id: `merged:${treeHash}`,
      kind: "local",
      label: `合并 ConfigTree ${treeHash.slice(0, 8)}`,
      treeHash,
      versionIds: [...input.snapshot.state.remoteHeads],
      writerIds,
      tree,
      items: merged.items,
      bytesByPath,
      compatibility,
      pluginChanges: summarizeConfigPluginChanges({
        diff,
        manifests: compatibility.status === "compatible" ? compatibility.manifests : {},
        sourceWriters: writerIds,
        compatibilityReasons: compatibility.status === "incompatible" ? compatibility.reasons : [],
      }),
    };
  }

  async publishConfigCandidate(input: {
    candidate: ConfigTreeSourceView;
    observedHeads: string[];
    confirmation: ConfigPublicationConfirmation;
    projectLocal: boolean;
    resolveObservedConflict: boolean;
  }): Promise<void> {
    this.beginRepositoryOperation("config");
    try {
      await this.publishConfigCandidateLocked(input);
    } finally {
      this.endRepositoryOperation("config");
    }
  }

  private async publishConfigCandidateLocked(input: {
    candidate: ConfigTreeSourceView;
    observedHeads: string[];
    confirmation: ConfigPublicationConfirmation;
    projectLocal: boolean;
    resolveObservedConflict: boolean;
  }): Promise<void> {
    const state = this.data.v1;
    if (!state) throw new Error("尚未连接仓库");
    if (this.data.v1ConfigSync.status === "recovery-required") throw new Error("配置恢复完成前不能发布新快照");
    if (input.confirmation.treeHash !== input.candidate.treeHash) throw new Error("配置发布确认已过期");
    const publicationDiff = diffManagedConfigItems([], input.candidate.items);
    if (publicationDiff.some((entry) => entry.codeChange) && !input.confirmation.acceptPluginCode) {
      throw new Error("配置发布需要单独确认插件代码");
    }
    if (publicationDiff.some((entry) => entry.sensitive) && !input.confirmation.acceptSensitiveData) {
      throw new Error("配置发布需要确认 plugin data 明文远端存储风险");
    }
    if (input.candidate.compatibility.status === "incompatible") {
      throw new Error(`目标 ConfigTree 不兼容：${input.candidate.compatibility.reasons.join("; ")}`);
    }

    const runtime = this.configWorkspaceRuntime(state);
    try {
      await this.assertV1RepositoryBinding(state);
      await this.drainDurableOutbox(state, runtime.staging);
      await this.reconcilePendingPublishedVaultMutations(this.data.v1 ?? state);
      await this.finalizePendingConfigPublication(state, runtime);
      const activeState = this.data.v1;
      if (!activeState) throw new Error("仓库绑定在配置发布期间丢失");
      const service = this.createRepositoryService(this.settings, activeState.locator.normalizedPrefix);
      const inspection = await service.inspectConfigRegister(activeState.repositoryId, activeState.descriptorHash);
      const refreshedState = await this.persistObservedRemoteState(activeState, inspection.acceptedCommits, inspection.observations);
      if (!sameHeads(inspection.headVersionIds, input.observedHeads)) throw new Error("配置快照头已变化，请刷新后重试");
      if (inspection.disposition === "pending" || inspection.disposition === "invalid") {
        throw new Error(`配置寄存器当前为 ${inspection.disposition}，不能发布解决版本`);
      }
      let candidate = input.candidate;
      if (input.projectLocal) {
        const captured = await captureLocalConfigSource({
          runtime,
          profile: candidate.tree.profile,
          previousItems: persistedConfigTreeItems(this.data.v1ConfigSync.projectedTree),
          repositoryId: refreshedState.repositoryId,
          descriptorHash: refreshedState.descriptorHash,
          configDir: refreshedState.configDir,
          historicalConfigDirs: refreshedState.historicalConfigDirs,
          currentAppVersion: apiVersion,
          isDesktop: Platform.isDesktop,
          syncPluginId: this.manifest.id,
          quietWindow: () => delay(500),
        });
        if (captured.result.status !== "captured" || !captured.source || captured.source.treeHash !== candidate.treeHash) {
          throw new Error("本地 ConfigTree 已变化，请刷新发布预览");
        }
        candidate = captured.source;
      }
      const reservation = reserveWriterCommit(refreshedState);
      const parents = configPublicationParents({
        projectLocal: input.projectLocal,
        resolveObservedConflict: input.resolveObservedConflict,
        projectedHeads: this.data.v1ConfigSync.projectedHeads,
        projectedTreeHash: this.data.v1ConfigSync.projectedTreeHash,
        observedHeads: inspection.headVersionIds,
        dirtyIntent: this.data.v1ConfigSync.dirtyIntent,
      });
      const publication = buildConfigSnapshotPublishEnvelope({
        prefix: refreshedState.locator.normalizedPrefix,
        repositoryId: refreshedState.repositoryId,
        descriptorHash: refreshedState.descriptorHash,
        writerId: refreshedState.writerId,
        sequence: reservation.sequence,
        previousCommitHash: reservation.previousCommitHash,
        createdAt: new Date().toISOString(),
        clientVersion: this.manifest.version,
        parents,
        tree: candidate.tree,
        bytesByPath: candidate.bytesByPath,
        binding: refreshedState,
      });
      if (publication.treeHash !== candidate.treeHash) throw new Error("冻结的 ConfigTree Hash 与确认预览不一致");
      const frozen = await freezeDurableOutbox({
        envelope: publication.envelope,
        repositoryFingerprint: refreshedState.repositoryFingerprint,
        writerId: refreshedState.writerId,
        sequence: reservation.sequence,
        previousCommitHash: reservation.previousCommitHash,
        captureGeneration: this.data.v1ConfigSync.generation,
        mutations: [{
          registerKey: "config:portable",
          versionId: publication.versionId,
          kind: "config-snapshot",
          parents: publication.parents,
          valueHash: publication.treeHash,
        }],
      }, runtime.staging);
      await this.causalStatePersistence;
      await this.savePluginData();
      const pendingConfig = {
        ...this.data.v1ConfigSync,
        publication: {
          outboxId: frozen.id,
          treeHash: publication.treeHash,
          tree: structuredClone(candidate.tree),
          projectLocal: input.projectLocal,
        },
      };
      const snapshot = await freezeDurableOutboxStateTransaction(
        await this.v1DurableStore(refreshedState),
        frozen,
        { configSync: JSON.parse(JSON.stringify(pendingConfig)) as StateJsonValue },
      );
      this.applyDurableOutboxSnapshot(snapshot.payload, true);
      await this.drainDurableOutbox(this.data.v1!, runtime.staging);
      await this.finalizePendingConfigPublication(this.data.v1!, runtime);
      await this.savePluginData();
    } catch (error) {
      this.recordConfigUiState("load-failed", this.errorMessage(error), runtime.recoveryLocation);
      this.queueCausalStatePersistence();
      throw error;
    }
  }

  async prepareConfigApply(targetTreeHash: string): Promise<ConfigApplyPreview> {
    const snapshot = await this.loadConfigCenterSnapshot();
    if (snapshot.state.status === "pending" || snapshot.state.status === "conflict"
      || snapshot.state.status === "incompatible" || snapshot.state.status === "recovery-required") {
      throw new Error(`当前配置状态不能应用：${snapshot.state.message}`);
    }
    if (!snapshot.local || snapshot.resolvedRemoteId === undefined) throw new Error("没有可应用的已解析远端 ConfigTree");
    const target = snapshot.remote.find((source) => source.id === snapshot.resolvedRemoteId && source.treeHash === targetTreeHash);
    if (!target) throw new Error("远端 ConfigTree 已变化，请刷新");
    if (target.compatibility.status === "incompatible") throw new Error(`目标 ConfigTree 不兼容：${target.compatibility.reasons.join("; ")}`);
    const state = this.data.v1;
    if (!state) throw new Error("尚未连接仓库");
    const runtime = this.configWorkspaceRuntime(state);
    const diff = diffManagedConfigItems(snapshot.local.items, target.items);
    const localByPath = new Map(snapshot.local.items.map((item) => [item.path, item]));
    const operations: ConfigBatchOperation[] = diff.filter((entry) => entry.kind !== "unchanged").map((entry) => {
      const before = localByPath.get(entry.path);
      const expected = before?.kind === "put"
        ? { kind: "present" as const, hash: before.hash, size: before.size }
        : { kind: "absent" as const };
      const after = entry.after;
      const targetValue = !after
        ? { kind: "stop-managing" as const }
        : after.kind === "delete"
          ? { kind: "delete" as const }
          : { kind: "put" as const, hash: after.hash, size: after.size, stagedRef: after.stagedRef };
      const pluginId = /^plugins\/([^/]+)\//.exec(entry.path)?.[1];
      return {
        path: entry.path,
        expected,
        target: targetValue,
        ...(pluginId ? { pluginId, loadedPlugin: snapshot.allLocalEnabledPluginIds.includes(pluginId) } : {}),
      };
    });

    const desiredEnabledIds = mergePortableEnabledPluginIds({
      remotePortableEnabled: target.tree.enabledCommunityPlugins,
      localEnabled: snapshot.allLocalEnabledPluginIds,
      portablePluginIds: target.tree.profile.portablePluginIds,
      localPluginDirectories: snapshot.inventory.map((entry) => entry.directoryId),
      syncPluginId: this.manifest.id,
    });
    const desiredEnabledBytes = encodeCommunityPluginIds(desiredEnabledIds);
    const communityStat = await runtime.port.stat("community-plugins.json");
    if (communityStat && communityStat.type !== "file") throw new Error("community-plugins.json 不是普通文件");
    const currentEnabledBytes = communityStat ? await runtime.port.read("community-plugins.json") : undefined;
    const desiredEnabledHash = sha256Hex(desiredEnabledBytes);
    const currentEnabledHash = currentEnabledBytes ? sha256Hex(currentEnabledBytes) : undefined;
    const applyDiff = [...diff];
    if (currentEnabledHash !== desiredEnabledHash) {
      const staged = await runtime.staging.stage(singleChunk(desiredEnabledBytes), desiredEnabledBytes.byteLength);
      operations.push({
        path: "community-plugins.json",
        expected: currentEnabledBytes
          ? { kind: "present", hash: currentEnabledHash!, size: currentEnabledBytes.byteLength }
          : { kind: "absent" },
        target: {
          kind: "put",
          hash: staged.hash,
          size: staged.size,
          stagedRef: `${runtime.statePrefix}/${staged.ref}`,
        },
      });
      applyDiff.push({
        path: "community-plugins.json",
        kind: currentEnabledBytes ? "modify" : "add",
        codeChange: false,
        sensitive: false,
      });
    }
    const newPluginIds = target.compatibility.risks
      .filter((risk) => risk.kind === "new-plugin")
      .map((risk) => risk.pluginId)
      .sort(compareUtf8);
    const plan: ConfigBatchPlan = {
      id: crypto.randomUUID(),
      repositoryFingerprint: state.repositoryFingerprint,
      targetHeads: [...target.versionIds],
      projectedHeads: [...this.data.v1ConfigSync.projectedHeads],
      projectedTreeHash: this.data.v1ConfigSync.projectedTreeHash ?? snapshot.local.treeHash,
      targetTreeHash: target.treeHash,
      operations,
      diff: applyDiff,
      newPluginIds,
    };
    const planHash = configBatchPlanHash(plan);
    return {
      plan,
      planHash,
      currentTreeHash: snapshot.local.treeHash,
      target,
      requirements: configTrustRequirements({
        diff: applyDiff,
        loadedPluginIds: snapshot.allLocalEnabledPluginIds,
        newPluginIds,
      }),
      recoveryLocation: runtime.recoveryLocation,
    };
  }

  async applyConfigPreview(preview: ConfigApplyPreview, confirmation: ConfigApplyTrustConfirmation): Promise<ConfigApplyOutcome> {
    this.beginRepositoryOperation("config");
    try {
      return await this.applyConfigPreviewLocked(preview, confirmation);
    } finally {
      this.endRepositoryOperation("config");
    }
  }

  private async applyConfigPreviewLocked(preview: ConfigApplyPreview, confirmation: ConfigApplyTrustConfirmation): Promise<ConfigApplyOutcome> {
    if (preview.planHash !== configBatchPlanHash(preview.plan) || confirmation.planHash !== preview.planHash) {
      throw new Error("配置应用确认已过期");
    }
    const state = this.data.v1;
    if (!state) throw new Error("尚未连接仓库");
    const runtime = this.configWorkspaceRuntime(state);
    try {
      await this.assertV1RepositoryBinding(state);
      const initial = await this.inspectCurrentConfigTarget(state, preview.plan.targetTreeHash);
      if (!initial.targetStillPresent || !sameHeads(initial.inspection.headVersionIds, preview.plan.targetHeads)) {
        this.recordConfigUiState("local-changes", "远端配置快照头已变化，请重新预览。", runtime.recoveryLocation);
        await this.savePluginData();
        return { result: { status: "stale-plan" }, state: this.getConfigSyncState() };
      }
      const applicator = this.createConfigBatchApplicator({
        runtime,
        state,
        plan: preview.plan,
        targetTree: preview.target.tree,
        targetItems: preview.target.items,
        currentTreeHash: preview.currentTreeHash,
      });
      const result = await applicator.apply(preview.plan, confirmation);
      this.finishConfigBatch(result, preview.plan, runtime);
      await this.savePluginData();
      return { result, state: this.getConfigSyncState() };
    } catch (error) {
      this.recordConfigUiState(this.data.v1ConfigSync.batchJournal ? "recovery-required" : "apply-failed", this.errorMessage(error), runtime.recoveryLocation);
      await this.persistV1DurableState();
      throw error;
    }
  }

  async recoverConfigBatch(action: "continue" | "rollback"): Promise<ConfigApplyOutcome> {
    this.beginRepositoryOperation("config");
    try {
      return await this.recoverConfigBatchLocked(action);
    } finally {
      this.endRepositoryOperation("config");
    }
  }

  private async recoverConfigBatchLocked(action: "continue" | "rollback"): Promise<ConfigApplyOutcome> {
    const state = this.data.v1;
    const journal = this.data.v1ConfigSync.batchJournal;
    const targetTree = this.data.v1ConfigSync.batchTargetTree;
    if (!state || !journal) throw new Error("没有可恢复的配置批次");
    if (!targetTree) throw new Error("配置批次缺少目标 Tree，只能按恢复位置人工处理");
    const runtime = this.configWorkspaceRuntime(state);
    try {
      await this.assertV1RepositoryBinding(state);
      const applicator = this.createConfigBatchApplicator({
        runtime,
        state,
        plan: journal.plan,
        targetTree,
        targetItems: configBatchTargetItems(targetTree, journal.plan),
        currentTreeHash: null,
      });
      const result = await applicator.recover(journal, action);
      this.finishConfigBatch(result, journal.plan, runtime);
      await this.savePluginData();
      return { result, state: this.getConfigSyncState() };
    } catch (error) {
      this.recordConfigUiState("recovery-required", this.errorMessage(error), runtime.recoveryLocation);
      await this.persistV1DurableState();
      throw error;
    }
  }

  private createConfigBatchApplicator(input: {
    runtime: ConfigWorkspaceRuntime;
    state: NonNullable<S3SyncData["v1"]>;
    plan: ConfigBatchPlan;
    targetTree: ProtocolConfigTree;
    targetItems: ManagedConfigItem[];
    currentTreeHash: string | null;
  }): SafeConfigBatchApplicator {
    return new SafeConfigBatchApplicator(input.runtime.files, {
      guard: async () => {
        const remote = await this.inspectCurrentConfigTarget(input.state, input.plan.targetTreeHash);
        return {
          repositoryFingerprint: this.data.v1?.repositoryFingerprint ?? "missing",
          observedHeads: remote.targetStillPresent ? remote.inspection.headVersionIds : [],
          projectedTreeHash: this.data.v1ConfigSync.projectedTreeHash ?? input.plan.projectedTreeHash,
          currentTreeHash: input.currentTreeHash,
          hasDirtyIntent: this.data.v1ConfigSync.dirtyIntent !== undefined,
        };
      },
      persistJournal: async (journal) => {
        this.data.v1ConfigSync = {
          ...this.data.v1ConfigSync,
          batchJournal: structuredClone(journal),
          batchTargetTree: structuredClone(input.targetTree),
          recoveryLocation: input.runtime.recoveryLocation,
        };
        await this.persistV1DurableState();
      },
      accountProjection: async (targetHeads, targetTreeHash) => {
        this.settings.configProfile = configProfileFromTree(input.targetTree);
        this.data.v1ConfigSync = {
          ...this.data.v1ConfigSync,
          status: "ready",
          projectedHeads: [...targetHeads],
          projectedTreeHash: targetTreeHash,
          projectedTree: structuredClone(input.targetTree),
          generation: this.data.v1ConfigSync.generation + 1,
          dirtyIntent: undefined,
          lastError: undefined,
          recoveryLocation: input.runtime.recoveryLocation,
        };
        await this.persistV1DurableState();
      },
      markConfigDirtyIntent: async (projectedHeads, projectedTreeHash) => {
        const generation = this.data.v1ConfigSync.generation + 1;
        this.data.v1ConfigSync = {
          ...this.data.v1ConfigSync,
          status: "local-changes",
          generation,
          dirtyIntent: this.data.v1ConfigSync.dirtyIntent ?? captureConfigDirtyIntent({ projectedHeads, projectedTreeHash, generation }),
        };
        await this.persistV1DurableState();
      },
      markRecoveryRequired: async (journal) => {
        this.data.v1ConfigSync = {
          ...this.data.v1ConfigSync,
          status: "recovery-required",
          batchJournal: structuredClone(journal),
          batchTargetTree: structuredClone(input.targetTree),
          recoveryLocation: input.runtime.recoveryLocation,
          lastError: "配置批次回滚未能安全完成，需要人工恢复。",
        };
        await this.persistV1DurableState();
      },
    }, {
      snapshotRef: (plan, path) => `${input.runtime.statePrefix}/recovery/config/${plan.id}/snapshot/${path}`,
      displacedBeforeRef: (plan, path) => `${input.runtime.statePrefix}/recovery/config/${plan.id}/before/${path}`,
      displacedAfterRef: (plan, path) => `${input.runtime.statePrefix}/recovery/config/${plan.id}/after/${path}`,
      verifyStaged: async (target) => {
        const observed = await input.runtime.files.observe(target.stagedRef);
        if (observed.kind !== "present" || observed.hash !== target.hash || observed.size !== target.size) {
          throw new Error("配置暂存文件 Hash 或大小不匹配");
        }
      },
      rebuildCurrentTreeHash: async () => {
        const rebuilt = await captureLocalConfigSource({
          runtime: input.runtime,
          profile: input.targetTree.profile,
          previousItems: input.targetItems,
          repositoryId: input.state.repositoryId,
          descriptorHash: input.state.descriptorHash,
          configDir: input.state.configDir,
          historicalConfigDirs: input.state.historicalConfigDirs,
          currentAppVersion: apiVersion,
          isDesktop: Platform.isDesktop,
          syncPluginId: this.manifest.id,
          quietWindow: () => delay(250),
        });
        return rebuilt.result.status === "captured" ? rebuilt.result.treeHash : null;
      },
    });
  }

  private async inspectCurrentConfigTarget(state: NonNullable<S3SyncData["v1"]>, targetTreeHash: string) {
    const inspection = await this.createRepositoryService(this.settings, state.locator.normalizedPrefix)
      .inspectConfigRegister(state.repositoryId, state.descriptorHash);
    const targetStillPresent = inspection.disposition === "resolved"
      && inspection.heads.length > 0
      && inspection.heads.every((head) => head.treeHash === targetTreeHash);
    return { inspection, targetStillPresent };
  }

  private async drainDurableOutbox(
    initialState: NonNullable<S3SyncData["v1"]>,
    staging: ImmutableContentStaging,
  ): Promise<void> {
    if (this.data.v1?.repositoryFingerprint !== initialState.repositoryFingerprint) {
      throw new Error("durable Outbox repository binding changed");
    }
    const service = this.createRepositoryService(this.settings, initialState.locator.normalizedPrefix);
    while (true) {
      const state = this.data.v1;
      if (!state) throw new Error("durable Outbox repository binding is missing");
      const terminalEntries = this.data.v1DurableOutbox
        .filter((candidate) => candidate.state === "integrity-error" || candidate.state === "recovery-required")
        .sort((left, right) => compareUtf8(left.writerId, right.writerId) || compareUtf8(left.sequence, right.sequence));
      const terminalEntry = terminalEntries[0];
      let entry = nextDurableOutbox(this.data.v1DurableOutbox, state.writerId);
      if (!terminalEntry && !entry) {
        const inactiveEntry = this.data.v1DurableOutbox.find((candidate) => candidate.state !== "published");
        if (!inactiveEntry) return;
        throw withDurableOutboxReplayStage(
          "writer-binding",
          new DiagnosticError(
            "DURABLE_OUTBOX_WRITER_MISMATCH",
            "integrity",
            "an unfinished durable Outbox entry belongs to an inactive writer; automatic replay was stopped",
          ),
        );
      }
      let store: DurableStateStore<StateJsonValue>;
      try {
        store = await this.v1DurableStore(state);
      } catch (error) {
        throw withDurableOutboxReplayStage("durable-open", error);
      }
      if (terminalEntry) {
        const verified = await service.verifyTerminalDurableOutboxRemoteCopy({
          repositoryId: state.repositoryId,
          descriptorHash: state.descriptorHash,
          entry: terminalEntry,
          source: staging,
          writerFrontiers: state.writerFrontiers,
        });
        const currentOperationalStatus = this.data.v1OperationalStatus;
        const recovered = terminalEntries.length === 1
          ? verifiedTerminalOutboxOperationalStatus(currentOperationalStatus)
          : currentOperationalStatus;
        const recoveredOperationalStatus = recovered === currentOperationalStatus ? undefined : recovered;
        await this.confirmVerifiedDurableOutboxRemoteState({
          state,
          entry: terminalEntry,
          store,
          service,
          anchor: verified.anchor,
          terminalProof: verified.proof,
          recoveredOperationalStatus,
        });
        continue;
      }
      entry = entry!;
      if (entry.state !== "publishing") {
        let started;
        try {
          started = await beginDurableOutboxPublicationTransaction(store, entry.id);
        } catch (error) {
          throw withDurableOutboxReplayStage("begin", error);
        }
        this.applyDurableOutboxSnapshot(started.payload, false);
        entry = this.data.v1DurableOutbox.find((candidate) => candidate.id === entry!.id)!;
      }
      try {
        const anchor = await service.replayDurableOutbox({
          repositoryId: state.repositoryId,
          descriptorHash: state.descriptorHash,
          entry,
          source: staging,
          writerFrontiers: state.writerFrontiers,
        });
        await this.confirmVerifiedDurableOutboxRemoteState({ state, entry, store, service, anchor });
      } catch (error) {
        const category = safeErrorRecord(error).category;
        const failure = category === "network" || category === "rate-limit" || category === "authentication"
          ? "retryable-error"
          : category === "integrity" ? "integrity-error" : "recovery-required";
        try {
          const failed = await failDurableOutboxPublicationTransaction(store, entry.id, failure);
          this.applyDurableOutboxSnapshot(failed.payload, false);
        } catch (stateError) {
          this.reportBackgroundError("Outbox 失败状态保存失败", stateError, "outbox-failure-persistence");
        }
        throw error;
      }
    }
  }

  private async confirmVerifiedDurableOutboxRemoteState(input: {
    state: NonNullable<S3SyncData["v1"]>;
    entry: DurableOutboxEntry;
    store: DurableStateStore<StateJsonValue>;
    service: V1RepositoryService;
    anchor: CommitFrontierAnchor;
    terminalProof?: VerifiedTerminalOutboxProof;
    recoveredOperationalStatus?: OperationalStatus;
  }): Promise<void> {
    let inspection;
    try {
      inspection = await input.service.inspectRepositoryState(input.state.repositoryId, input.state.descriptorHash);
    } catch (error) {
      throw withDurableOutboxReplayStage("inspect", error);
    }
    if (!inspection.acceptedCommits.some((candidate) => candidate.hash === input.entry.commitHash)) {
      throw withDurableOutboxReplayStage(
        "inspect",
        new Error("durable Outbox Commit integrity verification did not enter the accepted frontier"),
      );
    }
    const ingested = advanceIngestedCommitState(
      { frontiers: input.state.writerFrontiers, sparseSeenCommits: this.data.v1SparseSeenCommits },
      inspection.acceptedCommits,
    );
    const merged = mergeVerifiedRegisterObservations(inspection.observations, this.data.v1ProjectedHeads);
    const verifiedStatePatch = {
      observedRegisters: JSON.parse(JSON.stringify(merged.observedRegisters)) as StateJsonValue,
      pendingApply: JSON.parse(JSON.stringify(merged.pendingApply)) as StateJsonValue,
      writerFrontiers: JSON.parse(JSON.stringify(ingested.frontiers)) as StateJsonValue,
      sparseSeenCommits: JSON.parse(JSON.stringify(ingested.sparseSeenCommits)) as StateJsonValue,
      ...(input.recoveredOperationalStatus
        ? { operationalStatus: JSON.parse(JSON.stringify(input.recoveredOperationalStatus)) as StateJsonValue }
        : {}),
    };
    let confirmed;
    try {
      confirmed = input.terminalProof
        ? await confirmTerminalDurableOutboxPublishedTransaction(input.store, input.terminalProof, verifiedStatePatch)
        : await confirmDurableOutboxPublishedTransaction(input.store, input.entry.id, input.anchor.hash, verifiedStatePatch);
    } catch (error) {
      throw withDurableOutboxReplayStage("durable-confirm", error);
    }
    this.applyDurableOutboxSnapshot(confirmed.payload, false);
    if (input.recoveredOperationalStatus) this.data.v1OperationalStatus = input.recoveredOperationalStatus;
    this.updateOperationalStatus({ lastSuccessfulPublish: Date.now() });
  }

  private async drainDurableOutboxIfPresent(state: NonNullable<S3SyncData["v1"]>): Promise<void> {
    const staging = this.repositoryContentStaging(state);
    const replayed = this.data.v1DurableOutbox.some((entry) => entry.state !== "published");
    if (replayed) {
      await this.drainDurableOutbox(state, staging);
    }
    try {
      await this.reconcilePendingPublishedVaultMutations(this.data.v1 ?? state);
    } catch (error) {
      throw replayed ? withDurableOutboxReplayStage("reconcile", error) : error;
    }
  }

  private async freezePublishAndReconcileVaultPut(input: {
    state: NonNullable<S3SyncData["v1"]>;
    path: string;
    parents: string[];
    capture: Extract<StableStreamCaptureResult, { status: "captured" }>;
    captureGeneration: number;
  }): Promise<{ commitHash: string; versionId: string }> {
    let syncStage: SyncFlowStage = "outbox-freeze";
    try {
      const reservation = reserveWriterCommit(input.state);
      const publication = buildVaultPutControlEnvelope({
        prefix: input.state.locator.normalizedPrefix,
        repositoryId: input.state.repositoryId,
        descriptorHash: input.state.descriptorHash,
        writerId: input.state.writerId,
        sequence: reservation.sequence,
        previousCommitHash: reservation.previousCommitHash,
        createdAt: new Date().toISOString(),
        clientVersion: this.manifest.version,
        path: input.path,
        parents: input.parents,
        capture: input.capture,
      });
      const envelope = publication.envelope;
      const dirtyGeneration = this.data.v1DirtyIntents[input.path]?.generation;
      const eventGeneration = latestVaultEvent(this.data.v1VaultEvents, input.path)?.generation;
      const frozen = await freezeDurableOutbox({
        envelope,
        repositoryFingerprint: input.state.repositoryFingerprint,
        writerId: input.state.writerId,
        sequence: reservation.sequence,
        previousCommitHash: reservation.previousCommitHash,
        captureGeneration: input.captureGeneration,
        preStagedObjects: [{
          kind: "blob",
          key: publication.blob.key,
          hash: publication.blob.hash,
          size: publication.blob.size,
          contentRef: input.capture.stagedRef,
        }],
        mutations: [{
          registerKey: `vault:${input.path}`,
          versionId: `${envelope.commit.hash}:0:0`,
          kind: "put",
          parents: [...input.parents],
          valueHash: input.capture.hash,
          capturedDirtyGeneration: dirtyGeneration,
          capturedEventGeneration: eventGeneration,
        }],
      }, this.repositoryContentStaging(input.state));
      await this.causalStatePersistence;
      await this.savePluginData();
      const captured = await freezeDurableOutboxStateTransaction(
        await this.v1DurableStore(input.state),
        frozen,
        {
          dirtyIntents: JSON.parse(JSON.stringify(this.data.v1DirtyIntents)) as StateJsonValue,
          projections: this.repositoryState.projections(this.data),
        },
      );
      this.applyDurableOutboxSnapshot(captured.payload, false);
      syncStage = "publication";
      this.updateOperationalStatus({ phase: "publishing" });
      await this.drainDurableOutbox(this.data.v1!, this.repositoryContentStaging(this.data.v1!));
      syncStage = "publication-verification";
      this.updateOperationalStatus({ phase: "verifying-publication" });
      await this.causalStatePersistence;
      await this.reconcilePendingPublishedVaultMutations(this.data.v1!, frozen.id);
      const reconcile = this.data.v1PublishedReconciles.find((candidate) => candidate.outboxId === frozen.id && candidate.registerKey === `vault:${input.path}`);
      if (!reconcile || reconcile.state === "pending") throw new Error("Vault publication reconciliation did not complete");
      return { commitHash: frozen.commitHash, versionId: frozen.mutations[0].versionId };
    } catch (error) {
      throw withSyncFlowStage("push", syncStage, error);
    }
  }

  private async freezePublishAndReconcileVaultDelete(input: {
    state: NonNullable<S3SyncData["v1"]>;
    path: string;
    parents: string[];
    captureGeneration: number;
  }): Promise<{ commitHash: string; versionId: string }> {
    let syncStage: SyncFlowStage = "outbox-freeze";
    try {
      const reservation = reserveWriterCommit(input.state);
      const envelope = buildVaultDeleteControlEnvelope({
        prefix: input.state.locator.normalizedPrefix,
        repositoryId: input.state.repositoryId,
        descriptorHash: input.state.descriptorHash,
        writerId: input.state.writerId,
        sequence: reservation.sequence,
        previousCommitHash: reservation.previousCommitHash,
        createdAt: new Date().toISOString(),
        clientVersion: this.manifest.version,
        path: input.path,
        parents: input.parents,
      });
      const dirtyGeneration = this.data.v1DirtyIntents[input.path]?.generation;
      const eventGeneration = latestVaultEvent(this.data.v1VaultEvents, input.path)?.generation;
      const frozen = await freezeDurableOutbox({
        envelope,
        repositoryFingerprint: input.state.repositoryFingerprint,
        writerId: input.state.writerId,
        sequence: reservation.sequence,
        previousCommitHash: reservation.previousCommitHash,
        captureGeneration: input.captureGeneration,
        mutations: [{
          registerKey: `vault:${input.path}`,
          versionId: `${envelope.commit.hash}:0:0`,
          kind: "delete",
          parents: [...input.parents],
          valueHash: null,
          capturedDirtyGeneration: dirtyGeneration,
          capturedEventGeneration: eventGeneration,
        }],
      }, this.repositoryContentStaging(input.state));
      await this.causalStatePersistence;
      await this.savePluginData();
      const captured = await freezeDurableOutboxStateTransaction(
        await this.v1DurableStore(input.state),
        frozen,
        {
          dirtyIntents: JSON.parse(JSON.stringify(this.data.v1DirtyIntents)) as StateJsonValue,
          projections: this.repositoryState.projections(this.data),
        },
      );
      this.applyDurableOutboxSnapshot(captured.payload, false);
      syncStage = "publication";
      this.updateOperationalStatus({ phase: "publishing" });
      await this.drainDurableOutbox(this.data.v1!, this.repositoryContentStaging(this.data.v1!));
      syncStage = "publication-verification";
      this.updateOperationalStatus({ phase: "verifying-publication" });
      await this.causalStatePersistence;
      await this.reconcilePendingPublishedVaultMutations(this.data.v1!, frozen.id);
      const reconcile = this.data.v1PublishedReconciles.find((candidate) => candidate.outboxId === frozen.id && candidate.registerKey === `vault:${input.path}`);
      if (!reconcile || reconcile.state === "pending") throw new Error("Vault deletion reconciliation did not complete");
      return { commitHash: frozen.commitHash, versionId: frozen.mutations[0].versionId };
    } catch (error) {
      throw withSyncFlowStage("push", syncStage, error);
    }
  }

  private async reconcilePendingPublishedVaultMutations(
    state: NonNullable<S3SyncData["v1"]>,
    onlyOutboxId?: string,
  ): Promise<void> {
    for (const pending of [...this.data.v1PublishedReconciles]) {
      if (pending.state !== "pending" || !pending.registerKey.startsWith("vault:")
        || (onlyOutboxId !== undefined && pending.outboxId !== onlyOutboxId)) continue;
      const entry = this.data.v1DurableOutbox.find((candidate) => candidate.id === pending.outboxId);
      const mutation = entry?.mutations.find((candidate) => candidate.registerKey === pending.registerKey);
      if (!entry || entry.state !== "published" || !mutation) throw new Error("published Vault Outbox metadata is incomplete");
      const path = pending.registerKey.slice("vault:".length);
      const local = this.app.vault.getAbstractFileByPath(path);
      let localHash: string | null;
      if (local === null) localHash = null;
      else if (local instanceof TFile) {
        const capture = await this.captureVaultFileHash(path);
        if (!capture) continue;
        localHash = capture.hash;
      } else continue;

      const capturedDirtyGeneration = mutation.capturedDirtyGeneration ?? 0;
      const capturedEventGeneration = mutation.capturedEventGeneration ?? 0;
      const dirty = this.data.v1DirtyIntents[path];
      const newerDirty = dirty !== undefined && dirty.generation > capturedDirtyGeneration;
      const rebasedDirty = newerDirty ? {
        ...dirty,
        basisHeads: [],
        localPredecessorVersion: mutation.versionId,
        projectedValueHash: mutation.valueHash ?? undefined,
      } : undefined;
      let events = clearVaultEventsThroughGeneration(this.data.v1VaultEvents, path, capturedEventGeneration);
      events = bindVaultEventsAfterPublication(events, path, capturedEventGeneration, mutation.versionId);
      let laterEvent = latestVaultEvent(events, path);
      const localChanged = localHash !== mutation.valueHash;
      if (localChanged && !rebasedDirty && !laterEvent) {
        events = recordVaultEvent(events, {
          id: crypto.randomUUID(),
          kind: localHash === null ? "delete" : "upsert",
          path,
          projectedHeads: [mutation.versionId],
          previousGeneration: Math.max(this.data.v1VaultGenerations[path] ?? 0, capturedEventGeneration),
        });
        laterEvent = latestVaultEvent(events, path);
      }
      const completed = await completePublishedVaultOutboxTransaction(await this.v1DurableStore(state), {
        outboxId: entry.id,
        registerKey: mutation.registerKey,
        projectionKey: path,
        localValueHash: localHash,
        syntheticEventId: crypto.randomUUID(),
        dirtyIntent: rebasedDirty ? JSON.parse(JSON.stringify(rebasedDirty)) as StateJsonValue : null,
        vaultEvents: JSON.parse(JSON.stringify(events)) as StateJsonValue,
        vaultGeneration: Math.max(this.data.v1VaultGenerations[path] ?? 0, laterEvent?.generation ?? 0),
      });
      const liveDirtyIntents = this.data.v1DirtyIntents;
      const liveVaultEvents = this.data.v1VaultEvents;
      const liveVaultGenerations = this.data.v1VaultGenerations;
      this.applyDurableOutboxSnapshot(completed.payload, false);
      const record = completed.payload as Record<string, StateJsonValue>;
      const durableDirtyIntents = clonePayload<typeof this.data.v1DirtyIntents>(record.dirtyIntents, {});
      const mergedDirtyIntents = { ...durableDirtyIntents, ...liveDirtyIntents };
      const liveDirty = liveDirtyIntents[path];
      if (liveDirty && liveDirty.generation > capturedDirtyGeneration) {
        mergedDirtyIntents[path] = {
          ...liveDirty,
          basisHeads: [],
          localPredecessorVersion: mutation.versionId,
          projectedValueHash: mutation.valueHash ?? undefined,
        };
      } else if (durableDirtyIntents[path]) mergedDirtyIntents[path] = durableDirtyIntents[path];
      else delete mergedDirtyIntents[path];
      this.data.v1DirtyIntents = mergedDirtyIntents;
      this.data.v1VaultEvents = mergeVaultEventsAfterPublication(
        clonePayload(record.vaultEvents, []),
        liveVaultEvents,
        path,
        capturedEventGeneration,
        mutation.versionId,
      );
      const durableVaultGenerations = clonePayload<Record<string, number>>(record.vaultGenerations, {});
      this.data.v1VaultGenerations = { ...durableVaultGenerations };
      for (const [candidatePath, generation] of Object.entries(liveVaultGenerations)) {
        this.data.v1VaultGenerations[candidatePath] = Math.max(
          this.data.v1VaultGenerations[candidatePath] ?? 0,
          generation,
        );
      }
      const projections = clonePayload<Record<string, { projectedHeads: string[]; projectedValueHash: string | null; generation: number }>>(record.projections, {});
      const projection = projections[path];
      this.data.v1ProjectedHeads[path] = [...(projection?.projectedHeads ?? [mutation.versionId])];
      if (mutation.valueHash === null) delete this.data.files[path];
      else {
        const blob = entry.objects.find((object) => object.kind === "blob" && object.hash === mutation.valueHash);
        if (!blob) throw new Error("published Vault Outbox Blob metadata is missing");
        this.data.files[path] = { hash: mutation.valueHash, size: blob.size, updatedAt: new Date().toISOString() };
      }
      delete this.data.v1PendingApply[path];
      await this.persistV1DurableState();
    }
  }

  private async finalizePendingConfigPublication(
    state: NonNullable<S3SyncData["v1"]>,
    runtime: ConfigWorkspaceRuntime,
  ): Promise<void> {
    const publication = this.data.v1ConfigSync.publication;
    if (!publication) return;
    const entry = this.data.v1DurableOutbox.find((candidate) => candidate.id === publication.outboxId);
    if (!entry || entry.state !== "published") throw new Error("配置发布 Outbox 尚未完成验证");
    let localTreeHash: string | null = null;
    if (publication.projectLocal) {
      const captured = await captureLocalConfigSource({
        runtime,
        profile: publication.tree.profile,
        previousItems: persistedConfigTreeItems(publication.tree),
        repositoryId: state.repositoryId,
        descriptorHash: state.descriptorHash,
        configDir: state.configDir,
        historicalConfigDirs: state.historicalConfigDirs,
        currentAppVersion: apiVersion,
        isDesktop: Platform.isDesktop,
        syncPluginId: this.manifest.id,
        quietWindow: () => delay(500),
      });
      if (captured.result.status !== "captured" || !captured.source) {
        const reason = captured.result.status === "captured" ? "ConfigTree 视图缺失" : captured.result.reason;
        throw new Error(`发布后本地配置复查未完成：${reason}`);
      }
      localTreeHash = captured.source.treeHash;
    }
    const completed = await completePublishedConfigOutboxTransaction(
      await this.v1DurableStore(state),
      { outboxId: publication.outboxId, localTreeHash },
    );
    this.applyDurableOutboxSnapshot(completed.payload, true);
    if (publication.projectLocal) this.settings.configProfile = configProfileFromTree(publication.tree);
  }

  private applyDurableOutboxSnapshot(payload: StateJsonValue, includeConfigSync: boolean): void {
    const durable = validateRepositoryStatePayload(payload);
    const state = this.data.v1;
    if (!state || state.repositoryFingerprint !== durable.repositoryFingerprint) {
      throw new Error("durable Outbox state belongs to another repository binding");
    }
    const record = payload as Record<string, StateJsonValue>;
    this.data.v1 = {
      ...state,
      writerId: durable.writerId,
      nextSequence: durable.nextSequence,
      previousCommitHash: durable.previousCommitHash,
      writerFrontiers: durable.writerFrontiers,
    };
    this.data.v1DurableOutbox = clonePayload(record.durableOutbox, []);
    this.data.v1PublishedReconciles = clonePayload(record.publishedReconciles, []);
    this.data.v1SparseSeenCommits = clonePayload(record.sparseSeenCommits, {});
    this.data.v1ObservedRegisters = clonePayload(record.observedRegisters, {});
    this.data.v1PendingApply = clonePayload(record.pendingApply, {});
    if (includeConfigSync) {
      this.data.v1ConfigSync = {
        ...createDefaultConfigSyncState(),
        ...clonePayload<PersistedConfigSyncState>(record.configSync, this.data.v1ConfigSync),
      };
    }
  }

  private finishConfigBatch(result: ConfigBatchResult, plan: ConfigBatchPlan, runtime: ConfigWorkspaceRuntime): void {
    const changedFormalConfig = plan.operations.some((operation) => operation.target.kind !== "stop-managing");
    if (result.status === "accounted" || result.status === "adopted-without-write") {
      this.data.v1ConfigSync = {
        ...this.data.v1ConfigSync,
        status: "ready",
        batchJournal: undefined,
        batchTargetTree: undefined,
        reloadRequired: result.status === "accounted" && changedFormalConfig,
        lastError: undefined,
      };
    } else if (result.status === "rolled-back") {
      this.data.v1ConfigSync = { ...this.data.v1ConfigSync, batchJournal: undefined, batchTargetTree: undefined };
      this.recordConfigUiState("apply-failed", "配置应用失败，已回滚；恢复副本仍保留。", runtime.recoveryLocation);
    } else if (result.status === "recovery-required") {
      this.recordConfigUiState("recovery-required", "配置回滚需要人工恢复。", runtime.recoveryLocation);
    } else if (result.status === "local-change" || result.status === "stale-plan") {
      this.recordConfigUiState("local-changes", "确认后本地配置或远端快照头发生变化，请重新预览。", runtime.recoveryLocation);
    } else if (result.status === "conservative-only") {
      this.recordConfigUiState("apply-failed", "当前适配器只能生成候选，不能安全写入正式配置路径。", runtime.recoveryLocation);
    }
  }

  isV1OperationRunning(): boolean { return this.repositoryOperation.isRunning(); }

  async runManualSyncV1(): Promise<void> {
    this.cancelV1Retry(true);
    await this.runV1SyncRound(false);
  }

  async retryManualSyncV1(): Promise<void> {
    this.cancelV1Retry(true);
    await this.runV1SyncRound(false);
  }

  private async runV1SyncRound(fromRetry: boolean): Promise<void> {
    const state = this.data.v1;
    if (!state) {
      if (!fromRetry) this.reportActionBlocker(
        "REPOSITORY_NOT_CONNECTED",
        "repository-identity",
        "当前连接尚未绑定可用仓库；请先在设置中执行“检测并应用”。",
        "manual-sync-preflight",
      );
      return;
    }
    if (this.repositoryOperation.isRunning()) {
      if (fromRetry) this.deferV1Retry();
      else this.reportActionBlocker(
        "REPOSITORY_OPERATION_BUSY",
        "cancelled",
        "已有仓库操作正在运行；本次同步尚未开始。",
        "manual-sync-preflight",
      );
      return;
    }

    this.repositoryOperation.acquire("vault");
    this.updateOperationalStatus({ retryAt: undefined });
    try {
      const pull = await this.pullMissingFilesV1(false);
      if (pull.status === "failed") throw pull.error;
      if (pull.status === "blocked") {
        const message = `拉取发现 ${pull.conflicts} 项冲突和 ${pull.pending} 项待处理状态；本轮未上传。`;
        this.cancelV1Retry(true);
        this.updateOperationalStatus({ phase: "idle" });
        this.reportActionBlocker(
          "SYNC_BLOCKED_BY_UNRESOLVED_PATHS",
          "conflict",
          message,
          "sync-conflict-check",
          !fromRetry,
        );
        this.queueCausalStatePersistence();
        return;
      }
      this.repositoryOperation.throwIfAborted("vault");
      this.updateOperationalStatus({ phase: "scanning" });

      const published = await this.publishPendingPathsV1();

      this.cancelV1Retry(true);
      this.updateOperationalStatus({ phase: "idle", lastError: undefined });
      this.queueCausalStatePersistence();
      if (!fromRetry) new Notice(`S3 Sync：同步完成；发布 ${published} 个路径。`);
    } catch (error) {
      this.recordOperationalError(error, true);
    } finally {
      this.endRepositoryOperation("vault");
      this.updateStatus();
    }
  }

  private async buildV1PathDecisions(
    state: NonNullable<S3SyncData["v1"]>,
    pulled: V1VaultPullDiagnostics,
  ): Promise<PathDecisionRecord[]> {
    const candidates = new Set<string>();
    const remoteStates = new Map<string, PreviewRemoteState>();
    const ignoredPatterns = parseIgnorePatterns(this.settings.ignoredPatterns);

    for (const observation of pulled.observations) {
      if (!observation.key.startsWith("vault:")) continue;
      const path = observation.key.slice("vault:".length);
      candidates.add(path);
      if (observation.disposition === "concurrent") {
        remoteStates.set(path, { kind: "conflict", reason: `远端寄存器包含 ${observation.heads.length} 个并发头` });
      } else if (observation.disposition === "pending") {
        remoteStates.set(path, { kind: "unknown", reason: `远端寄存器仍有 ${observation.pending.length} 个依赖待验证` });
      } else if (observation.disposition === "invalid") {
        remoteStates.set(path, { kind: "unknown", reason: `远端寄存器包含 ${observation.invalid.length} 个无效版本` });
      } else if (typeof observation.valueHash === "string") {
        remoteStates.set(path, { kind: "put", hash: observation.valueHash });
      } else if (observation.valueHash === null) {
        remoteStates.set(path, { kind: "delete" });
      } else if (observation.heads.length === 0) {
        remoteStates.set(path, { kind: "none" });
      } else {
        remoteStates.set(path, { kind: "unknown", reason: "远端解析值缺少可验证内容" });
      }
    }
    for (const file of pulled.files) {
      candidates.add(file.path);
      remoteStates.set(file.path, { kind: "put", hash: file.hash });
    }
    for (const blocked of pulled.blocked) {
      candidates.add(blocked.path);
      remoteStates.set(blocked.path, { kind: "unknown", reason: this.errorMessage(blocked.reason) });
    }

    const occupiedPaths = [
      ...pulled.files.flatMap((file) => file.heads.map((versionId) => ({ path: file.path, versionId }))),
      ...this.app.vault.getFiles().map((file) => ({ path: normalizePath(file.path), versionId: `local:${normalizePath(file.path)}` })),
    ];
    if (findStructuralConflicts(occupiedPaths).length > 0
      || findCaseAliasConflicts(occupiedPaths, vaultPathCaseFoldKey).length > 0) {
      throw new DiagnosticError(
        "REMOTE_STRUCTURAL_PATH_CONFLICT",
        "conflict",
        "remote and local paths contain a file/directory collision or portable case alias; no local bytes were changed",
      );
    }

    for (const file of this.app.vault.getFiles()) candidates.add(normalizePath(file.path));
    for (const path of Object.keys(this.data.files)) candidates.add(path);
    for (const path of Object.keys(this.data.v1ProjectedHeads)) candidates.add(path);
    for (const path of Object.keys(this.data.v1DirtyIntents)) candidates.add(path);
    for (const event of this.data.v1VaultEvents) candidates.add(event.path);
    for (const path of Object.keys(this.data.v1LocalConcurrentRecords)) candidates.add(path);
    for (const path of Object.keys(this.data.v1PendingApply)) candidates.add(path);
    for (const conflict of Object.values(this.data.conflicts)) if (!conflict.resolved) candidates.add(conflict.path);
    for (const reconcile of this.data.v1PublishedReconciles) {
      if (reconcile.registerKey.startsWith("vault:")) candidates.add(reconcile.registerKey.slice("vault:".length));
    }

    const conflictPaths = new Set(Object.values(this.data.conflicts)
      .filter((conflict) => !conflict.resolved)
      .map((conflict) => conflict.path));

    const decisions: PathDecisionRecord[] = [];
    for (const path of [...candidates].sort(compareUtf8)) {
      const remote = remoteStates.get(path) ?? { kind: "none" as const };
      const ignored = isVaultPathExcluded(path, this.app.vault.configDir, state.historicalConfigDirs)
        || isIgnored(path, ignoredPatterns);
      const abstract = this.app.vault.getAbstractFileByPath(path);
      const file = abstract instanceof TFile ? abstract : undefined;
      let localState: "absent" | "present" | "unknown" = abstract === null ? "absent" : file ? "present" : "unknown";
      let localHash: string | undefined;
      if (!ignored && file && (remote.kind === "put" || remote.kind === "delete")) {
        const capture = await this.captureVaultFileHash(path);
        if (capture) localHash = capture.hash;
        else localState = "unknown";
      }

      const dirtyIntent = this.data.v1DirtyIntents[path];
      const vaultEvent = latestVaultEvent(this.data.v1VaultEvents, path);
      const projected = this.data.files[path];
      let localIntent: "none" | "put" | "delete" = dirtyIntent
        ? "put"
        : vaultEvent?.kind === "delete" ? "delete"
          : vaultEvent?.kind === "upsert" ? "put" : "none";
      if (localIntent === "none" && localState === "present") {
        const matchesUntrackedRemote = !projected && remote.kind === "put" && localHash === remote.hash;
        if ((!projected && !matchesUntrackedRemote) || (projected && localHash !== undefined && projected.hash !== localHash)) {
          localIntent = "put";
        }
      } else if (localIntent === "none" && localState === "absent" && projected) {
        localIntent = "delete";
      }

      if (!ignored && (localConcurrentRecordBlocksAutomaticWork(this.data.v1LocalConcurrentRecords[path]) || conflictPaths.has(path))) {
        decisions.push({ path, decision: "conflict", reason: "本地并发记录或未解决 Vault 冲突阻止自动选择" });
        continue;
      }
      if (!ignored && publishedReconcileBlocksAutomaticApply(this.data.v1PublishedReconciles, `vault:${path}`)) {
        decisions.push({ path, decision: "unknown", reason: "已发布变更仍等待本地对账" });
        continue;
      }
      decisions.push(derivePathDecision({ path, ignored, localState, localHash, localIntent, remote }));
    }
    return decisions;
  }

  async previewSyncV1(openDashboard = true): Promise<void> {
    const state = this.data.v1;
    if (!state) {
      this.reportActionBlocker(
        "REPOSITORY_NOT_CONNECTED",
        "repository-identity",
        "当前连接尚未绑定可用仓库；请先在设置中执行“检测并应用”。",
        "inspection-preflight",
      );
      return;
    }
    if (!this.repositoryOperation.tryAcquire("vault")) {
      this.reportActionBlocker(
        "REPOSITORY_OPERATION_BUSY",
        "cancelled",
        "已有仓库操作正在运行；本次检查尚未开始。",
        "inspection-preflight",
      );
      return;
    }
    this.updateOperationalStatus({ phase: "previewing", decisions: [], lastError: undefined });
    try {
      await this.assertV1RepositoryBinding(state);
      const pulled = await this.createRepositoryService(this.settings, state.locator.normalizedPrefix).listResolvedVaultPutsWithDiagnostics(state.repositoryId, state.descriptorHash);
      const decisions = await this.buildV1PathDecisions(state, pulled);
      this.updateOperationalStatus({ decisions });
      if (pulled.blockedCommitKeys.length > 0) throw pulled.blockedCommitKeys[0].reason;
      this.updateOperationalStatus({ phase: "idle" });
      if (openDashboard) new SyncDashboardModal(this).open();
    } catch (error) {
      this.recordOperationalError(error);
    } finally {
      this.endRepositoryOperation("vault");
    }
    this.updateStatus();
  }

  async runFullAuditV1(): Promise<void> {
    const state = this.data.v1;
    if (!state) {
      this.reportActionBlocker(
        "REPOSITORY_NOT_CONNECTED",
        "repository-identity",
        "当前连接尚未绑定可用仓库；请先在设置中执行“检测并应用”。",
        "audit-preflight",
      );
      return;
    }
    if (!this.repositoryOperation.tryAcquire("vault")) {
      this.reportActionBlocker(
        "REPOSITORY_OPERATION_BUSY",
        "cancelled",
        "已有仓库操作正在运行；本次完整校验尚未开始。",
        "audit-preflight",
      );
      return;
    }
    const signal = this.repositoryOperation.currentSignal()!;
    this.updateOperationalStatus({ phase: "auditing", audit: { state: "running", completedObjects: 0, totalObjects: 0, missingClosure: [], resumable: true } });
    try {
      await this.assertV1RepositoryBinding(state);
      const result = await this.createRepositoryService(this.settings, state.locator.normalizedPrefix).fullAudit(
        state.repositoryId,
        state.descriptorHash,
        (progress) => this.updateOperationalStatus({
          phase: "auditing",
          audit: { state: "running", ...progress, resumable: true },
        }),
        { signal, sliceSize: 64, yieldToIdle: () => delay(0) },
      );
      const now = Date.now();
      this.updateOperationalStatus({
        phase: "idle",
        lastSuccessfulAudit: now,
        audit: {
          state: "complete",
          completedObjects: result.verifiedObjects,
          totalObjects: result.totalObjects,
          missingClosure: [...result.missingClosure],
          resumable: false,
          completedAt: now,
          space: summarizeRepositorySpace(result.space),
        },
        lastError: undefined,
      });
      await this.saveSyncData();
      new Notice(`S3 Sync 完整校验通过：${result.verifiedObjects} 个对象，${result.commits} 个 Commit。`);
    } catch (error) {
      const partial = remoteAuditFailureProgress(error);
      const cancelled = signal.aborted;
      this.updateOperationalStatus({
        ...(cancelled ? { phase: "idle" as const, lastError: undefined } : {}),
        audit: {
          ...this.data.v1OperationalStatus.audit,
          ...(partial ?? {}),
          state: cancelled ? "cancelled" : "failed",
          resumable: true,
        },
      });
      if (cancelled) new Notice("S3 Sync：完整校验已取消；本次部分结果不会作为删除依据。");
      else this.recordOperationalError(error);
    } finally {
      this.endRepositoryOperation("vault");
    }
    this.updateStatus();
  }

  cancelFullAuditV1(): void {
    if (this.data.v1OperationalStatus.phase !== "auditing") return;
    this.repositoryOperation.abort("vault");
  }

  exportRedactedDiagnostics(): string {
    const status = this.getOperationalStatus();
    const knownPaths = new Set<string>([
      ...Object.keys(this.data.files),
      ...Object.keys(this.data.v1DirtyIntents),
      ...Object.keys(this.data.v1ProjectedHeads),
      ...Object.keys(this.data.v1PendingApply),
      ...Object.keys(this.data.v1LocalConcurrentRecords),
      ...this.data.v1VaultEvents.map((event) => event.path),
      ...this.data.v1ApplyJournals.map((journal) => journal.path),
      ...Object.values(this.data.conflicts).map((conflict) => conflict.path),
      ...Object.values(this.data.v1RecoveryRecords).flatMap((record) => [record.logicalPath, record.contentRef]),
      this.app.vault.configDir,
      ...(this.data.v1?.historicalConfigDirs ?? []),
      this.settings.prefix,
      this.data.v1?.locator.normalizedPrefix ?? "",
    ]);
    return JSON.stringify(buildRedactedDiagnosticBundle({
      generatedAt: Date.now(),
      repositoryId: this.data.v1?.repositoryId,
      normalizedPrefix: this.data.v1?.locator.normalizedPrefix,
      pathSalt: this.data.v1?.repositoryId ?? this.runtimeContractSessionId,
      sensitiveValues: [this.settings.accessKeyId, this.settings.secretAccessKey, ...knownPaths],
      status: {
        ...(status as unknown as Record<string, unknown>),
        performance: {
          profile: repositoryPerformanceProfile,
          hashExecutor: this.vaultHashExecutor.metrics(),
        },
      },
      events: [
        ...status.decisions.map((decision) => ({ at: Date.now(), category: decision.decision === "conflict" ? "conflict" as const : "local-path" as const, stage: decision.decision, message: decision.reason, path: decision.path })),
        ...(status.lastError ? [{ at: Date.now(), category: status.lastError.category, stage: status.phase, message: status.lastError.message }] : []),
      ],
    }), null, 2);
  }

  private async publishPendingPathsV1(): Promise<number> {
    this.repositoryOperation.assertHeldBy("vault");
    const orderedPaths: string[] = [];
    const seen = new Set<string>();
    const append = (path: string): void => {
      if (!seen.has(path)) {
        seen.add(path);
        orderedPaths.push(path);
      }
    };
    for (const event of this.data.v1VaultEvents) append(event.path);
    for (const path of Object.keys(this.data.v1DirtyIntents).sort(compareUtf8)) append(path);
    for (const decision of this.data.v1OperationalStatus.decisions) {
      if (decision.decision === "local-put" || decision.decision === "tombstone") append(decision.path);
    }

    let published = 0;
    for (const path of orderedPaths) {
      if (!this.isV1ManagedVaultPath(path)) continue;
      const local = this.app.vault.getAbstractFileByPath(path);
      const decision = this.data.v1OperationalStatus.decisions.find((candidate) => candidate.path === path)?.decision;
      if (!latestVaultEvent(this.data.v1VaultEvents, path) && !this.data.v1DirtyIntents[path]) {
        if (local instanceof TFile && decision === "local-put") this.vaultEvents.recordEvent("upsert", path);
        else if (local === null && this.data.files[path] && decision === "tombstone") this.vaultEvents.recordEvent("delete", path);
        else continue;
      }
      const result = await this.publishPathV1(path);
      if (result.status === "failed") throw result.error;
      if (result.status === "success") published += 1;
    }
    return published;
  }

  private async publishPathV1(path: string): Promise<V1OperationResult> {
    this.repositoryOperation.assertHeldBy("vault");
    let syncStage: SyncFlowStage = "preflight";
    try {
      this.assertV1SyncPreflight();
      syncStage = "repository-selection";
      let state = this.data.v1;
      if (!state || state.locator.normalizedPrefix !== this.getEffectivePrefix()) {
        throw new Error("connect the repository for the current Prefix first");
      }
      syncStage = "repository-verification";
      this.updateOperationalStatus({ phase: "verifying-repository" });
      await this.assertV1RepositoryBinding(state);
      this.recoverVerifiedRepositoryIdentityLock();
      syncStage = "outbox-replay";
      await this.drainDurableOutboxIfPresent(state);
      syncStage = "preflight";
      this.assertV1SyncPreflight();
      this.updateOperationalStatus({ lastError: undefined });
      state = this.data.v1!;
      syncStage = "active-file-validation";
      if (!this.isV1ManagedVaultPath(path)) throw new DiagnosticError("VAULT_PATH_OUT_OF_SCOPE", "local-path", "path is outside the managed Vault scope");
      const local = this.app.vault.getAbstractFileByPath(path);
      if (local !== null && !(local instanceof TFile)) {
        throw new DiagnosticError("VAULT_PATH_NOT_FILE", "local-path", "path is occupied by a non-file entry");
      }
      const file = local instanceof TFile ? local : undefined;
      const registerKey = `vault:${path}`;
      if (localConcurrentRecordBlocksAutomaticWork(this.data.v1LocalConcurrentRecords[path])) {
        throw new Error("LocalConcurrentRecord must be resolved before publishing this path");
      }
      if (publishedReconcileBlocksAutomaticApply(this.data.v1PublishedReconciles, registerKey)) {
        throw new Error("published Mutation still requires local reconciliation");
      }
      if (Object.values(this.data.conflicts).some((conflict) => !conflict.resolved && conflict.path === path)) {
        new ConflictModal(this).open();
        throw new Error("Vault conflict must be resolved before publishing this path");
      }
      const dirtyIntent = this.data.v1DirtyIntents[path];
      const vaultEvent = latestVaultEvent(this.data.v1VaultEvents, path);
      const deleting = !file && vaultEvent?.kind === "delete";
      if (!file && !deleting) throw new DiagnosticError("VAULT_FILE_NOT_STABLE", "local-path", "local file is unavailable and no confirmed delete event exists");
      let observedCapture: Awaited<ReturnType<S3SyncPlugin["captureVaultFileHash"]>>;
      if (file) {
        syncStage = "stable-capture";
        this.updateOperationalStatus({ phase: "scanning" });
        observedCapture = await this.captureVaultFileHash(path);
        if (!observedCapture) throw new DiagnosticError("VAULT_CAPTURE_UNSTABLE", "local-path", "file changed during stable Hash capture");
        if (this.data.v1DirtyIntents[path]?.generation !== dirtyIntent?.generation
          || latestVaultEvent(this.data.v1VaultEvents, path)?.generation !== vaultEvent?.generation) {
          throw new DiagnosticError("VAULT_GENERATION_CHANGED", "local-path", "local causal generation changed during capture");
        }
        if (dirtyIntent?.awaitingLocalWrite && observedCapture.hash !== dirtyIntent.expectedContentHash) {
          throw new DiagnosticError("EDITOR_WRITE_PENDING", "local-path", "editor bytes have not reached stable disk content");
        }
      }
      syncStage = "remote-refresh";
      const service = this.createRepositoryService(this.settings, state.locator.normalizedPrefix);
      this.updateOperationalStatus({ phase: "repulling" });
      const pulled = await service.inspectVaultRegisterWithAnchors(state.repositoryId, state.descriptorHash, path);
      syncStage = "remote-state-persistence";
      this.updateOperationalStatus({ phase: "merging" });
      state = await this.persistObservedRemoteState(state, pulled.acceptedCommits, pulled.observations);
      syncStage = "conflict-check";
      const remote = pulled.register;
      const parents = dirtyIntent
        ? dirtyIntent.localPredecessorVersion ? [dirtyIntent.localPredecessorVersion] : dirtyIntent.basisHeads
        : vaultEvent ? vaultEvent.localPredecessorVersion ? [vaultEvent.localPredecessorVersion] : vaultEvent.basisHeads
          : this.data.v1ProjectedHeads[path] ?? [];
      if (remote.disposition !== "resolved") {
        const id = this.recordV1ConcurrentConflict(
          path,
          this.data.files[path]?.hash ?? null,
          observedCapture?.hash ?? null,
          remote.heads,
          remote.candidates,
        );
        await this.saveSyncData();
        await this.materializeConflictCopies(state, service, id, path, remote.candidates);
        new ConflictModal(this).open();
        throw new DiagnosticError("REMOTE_REGISTER_CONCURRENT", "conflict", "remote register is not resolved");
      }
      const remoteCandidate = remote.candidates[0];
      const sameValue = deleting
        ? remoteCandidate?.kind === "delete" || remote.heads.length === 0
        : remoteCandidate?.kind === "put" && remoteCandidate.hash === observedCapture!.hash;
      if (!sameHeads(remote.heads, parents)) {
        if (sameValue) {
          if (remoteCandidate?.kind === "put") {
            this.data.files[path] = { hash: remoteCandidate.hash, size: remoteCandidate.size, updatedAt: new Date().toISOString() };
          } else {
            delete this.data.files[path];
          }
          this.data.v1ProjectedHeads[path] = [...remote.heads];
          delete this.data.v1DirtyIntents[path];
          delete this.data.v1PendingApply[path];
          if (vaultEvent) this.data.v1VaultEvents = clearVaultEventsThroughGeneration(this.data.v1VaultEvents, path, vaultEvent.generation);
          await this.saveSyncData();
          return { status: "success" };
        }
        const id = this.recordV1ConcurrentConflict(
          path,
          this.data.files[path]?.hash ?? null,
          observedCapture?.hash ?? null,
          remote.heads,
          remote.candidates,
        );
        await this.saveSyncData();
        await this.materializeConflictCopies(state, service, id, path, remote.candidates);
        new ConflictModal(this).open();
        throw new DiagnosticError("LOCAL_REMOTE_DIVERGED", "conflict", "remote heads changed after the local generation was captured");
      }
      if (deleting && remote.heads.length === 0) {
        delete this.data.files[path];
        delete this.data.v1DirtyIntents[path];
        delete this.data.v1PendingApply[path];
        if (vaultEvent) this.data.v1VaultEvents = clearVaultEventsThroughGeneration(this.data.v1VaultEvents, path, vaultEvent.generation);
        await this.saveSyncData();
        return { status: "success" };
      }
      syncStage = "stable-capture";
      this.updateOperationalStatus({ phase: "freezing-outbox" });
      syncStage = "outbox-freeze";
      const captureGeneration = Math.max(
        dirtyIntent?.generation ?? 0,
        vaultEvent?.generation ?? 0,
        this.data.v1VaultGenerations[path] ?? 0,
      );
      let published: { commitHash: string; versionId: string };
      if (deleting) {
        published = await this.freezePublishAndReconcileVaultDelete({ state, path, parents, captureGeneration });
        delete this.data.files[path];
      } else {
        const capture = await this.captureVaultFileToStaging(state, path);
        if (capture.status !== "captured") throw new Error(vaultCaptureFailureMessage(path, capture));
        if (capture.hash !== observedCapture!.hash || capture.size !== observedCapture!.size
          || this.data.v1DirtyIntents[path]?.generation !== dirtyIntent?.generation
          || latestVaultEvent(this.data.v1VaultEvents, path)?.generation !== vaultEvent?.generation) {
          throw new DiagnosticError("VAULT_CHANGED_BEFORE_FREEZE", "local-path", "local bytes or causal generation changed before Outbox freeze");
        }
        published = await this.freezePublishAndReconcileVaultPut({ state, path, parents, capture, captureGeneration });
        this.data.files[path] = { hash: capture.hash, size: capture.size, updatedAt: new Date().toISOString() };
        if (dirtyIntent?.localCandidates.length) {
          this.data.v1RecoveryCandidates[path] = dirtyIntent.localCandidates.map((candidate) => ({ ...candidate }));
        }
      }
      this.data.v1ProjectedHeads[path] = [published.versionId];
      delete this.data.v1PendingApply[path];
      if (vaultEvent) this.data.v1VaultEvents = clearVaultEventsThroughGeneration(this.data.v1VaultEvents, path, vaultEvent.generation);
      if (parents.length === 0) this.data.v1VaultEvents = bindRootDeletePredecessor(this.data.v1VaultEvents, path, vaultEvent?.generation ?? 0, published.versionId);
      syncStage = "local-persistence";
      this.updateOperationalStatus({ lastSuccessfulPublish: Date.now() });
      await this.saveSyncData();
      return { status: "success" };
    } catch (error) {
      const stagedError = withSyncFlowStage("push", syncStage, error);
      logSafeError("S3 Sync Vault publication failed", stagedError);
      return { status: "failed", error: stagedError };
    }
  }

  private async pullMissingFilesV1(notify = true): Promise<V1OperationResult> {
    if (notify && !this.repositoryOperation.tryAcquire("vault")) {
      const error = new DiagnosticError("REPOSITORY_OPERATION_BUSY", "internal", "another repository operation is running");
      this.recordOperationalError(withSyncFlowStage("pull", "preflight", error));
      return { status: "failed", error };
    }
    if (!notify) this.repositoryOperation.assertHeldBy("vault");
    if (notify) this.cancelV1Retry(true);
    let syncStage: SyncFlowStage = "preflight";
    try {
      this.assertV1InspectionPreflight();
      syncStage = "repository-selection";
      let state = this.data.v1;
      if (!state || state.locator.normalizedPrefix !== this.getEffectivePrefix()) throw new Error("connect the repository for the current Prefix first");
      syncStage = "repository-verification";
      this.updateOperationalStatus({ phase: "verifying-repository" });
      await this.assertV1RepositoryBinding(state);
      this.recoverVerifiedRepositoryIdentityLock();
      const service = this.createRepositoryService(this.settings, state.locator.normalizedPrefix);
      let inspected = await this.inspectAndMaterializeVaultV1(state, service);
      let blocked = this.v1PullBlockSummary(inspected.decisions);
      if (blocked.conflicts > 0 || blocked.pending > 0) {
        return this.finishV1Pull(inspected.decisions, {
          created: 0,
          updated: 0,
          deleted: 0,
          skipped: inspected.materializedConflicts,
        }, notify);
      }

      syncStage = "preflight";
      this.assertV1SyncPreflight();
      const hadOutbox = this.data.v1DurableOutbox.some((entry) => entry.state !== "published")
        || this.data.v1PublishedReconciles.some((entry) => entry.state === "pending");
      syncStage = "outbox-replay";
      await this.drainDurableOutboxIfPresent(inspected.state);
      if (hadOutbox) {
        inspected = await this.inspectAndMaterializeVaultV1(this.data.v1!, service);
        blocked = this.v1PullBlockSummary(inspected.decisions);
        if (blocked.conflicts > 0 || blocked.pending > 0) {
          return this.finishV1Pull(inspected.decisions, {
            created: 0,
            updated: 0,
            deleted: 0,
            skipped: inspected.materializedConflicts,
          }, notify);
        }
      }

      this.updateOperationalStatus({ lastError: undefined });
      state = inspected.state;
      const pulled = inspected.pulled;
      const decisions = inspected.decisions;
      const files = pulled.files;
      const decisionByPath = new Map(decisions.map((decision) => [decision.path, decision]));
      const replaceDecision = (decision: PathDecisionRecord): void => {
        decisionByPath.set(decision.path, decision);
        const index = decisions.findIndex((candidate) => candidate.path === decision.path);
        if (index >= 0) decisions[index] = decision;
        else decisions.push(decision);
      };
      let created = 0;
      let updated = 0;
      let deleted = 0;
      let skipped = inspected.materializedConflicts;
      syncStage = "local-apply";
      this.updateOperationalStatus({ phase: "applying" });
      for (const remote of files) {
        this.repositoryOperation.throwIfAborted("vault");
        const registerKey = `vault:${remote.path}`;
        const previewDecision = decisionByPath.get(remote.path)?.decision;
        if (previewDecision === "ignored" || previewDecision === "unknown" || previewDecision === "tombstone") {
          skipped += 1;
          continue;
        }
        if (!mayApplyRemoteWithEditorIntent(this.data.v1DirtyIntents[remote.path]) || latestVaultEvent(this.data.v1VaultEvents, remote.path)) {
          skipped += 1;
          continue;
        }
        if (localConcurrentRecordBlocksAutomaticWork(this.data.v1LocalConcurrentRecords[remote.path])
          || publishedReconcileBlocksAutomaticApply(this.data.v1PublishedReconciles, registerKey)
          || Object.values(this.data.conflicts).some((conflict) => !conflict.resolved && conflict.path === remote.path)) {
          skipped += 1;
          continue;
        }
        const existing = getTFile(this.app.vault, remote.path);
        const capture = existing ? await this.captureVaultFileHash(remote.path) : undefined;
        const decision = decideResolvedRemotePut({ localExists: !!existing, projectedHash: this.data.files[remote.path]?.hash, currentHash: capture?.hash, remoteHash: remote.hash });
        if (decision === "conflict") {
          replaceDecision({ path: remote.path, decision: "conflict", reason: "应用前复查发现本地与远端内容均已变化" });
          const id = this.recordV1Conflict(
            remote.path,
            this.data.files[remote.path]?.hash ?? null,
            capture?.hash ?? null,
            remote.hash,
            remote.size,
            remote.heads,
          );
          await this.saveSyncData();
          await this.materializeConflictCopies(
            state,
            service,
            id,
            remote.path,
            remote.heads.map((versionId) => ({
              kind: "put" as const,
              versionId,
              hash: remote.hash,
              size: remote.size,
            })),
          );
          skipped += 1;
          continue;
        }
        if (decision === "adopt") {
          this.data.files[remote.path] = { hash: remote.hash, size: remote.size, updatedAt: new Date().toISOString() };
          this.data.v1ProjectedHeads[remote.path] = [...remote.heads];
          delete this.data.v1PendingApply[remote.path];
          continue;
        }
        const binary = await service.downloadVaultBlob(state.repositoryId, remote);
        const staged = await this.repositoryContentStaging(state).stage(oneChunk(binary), remote.size);
        const stateRoot = localStateRoot(state.configDir, state.repositoryId);
        const candidate: RemoteVaultConflictCandidate = {
          kind: "put",
          versionId: remote.heads[0],
          hash: remote.hash,
          size: remote.size,
        };
        const plan = this.buildVaultApplyPlan(state, remote.path, remote.heads, {
          kind: "put",
          hash: remote.hash,
          size: remote.size,
          stagedRef: `${stateRoot}/${staged.ref}`,
        });
        const result = await this.createVaultApplicator(state, { heads: remote.heads, candidate }).apply(plan);
        if (result.status === "accounted" || result.status === "adopted-without-write") {
          if (decision === "create") created += 1;
          else updated += 1;
        } else {
          if (result.status === "local-change-frozen") {
            const id = conflictId(state.repositoryId, "vault", [remote.path], remote.heads);
            for (const versionId of remote.heads) {
              await this.writeConflictCopy(
                conflictVersionCopyPath(id, versionId, remote.path),
                binary,
                remote,
              );
            }
          }
          replaceDecision({
            path: remote.path,
            decision: result.status === "local-change-frozen" ? "conflict" : "unknown",
            reason: safeApplyResultMessage(result.status),
          });
          skipped += 1;
        }
      }

      const remoteDeletes = pulled.observations
        .filter((observation) => observation.key.startsWith("vault:")
          && observation.disposition === "resolved"
          && observation.valueHash === null
          && observation.heads.length === 1)
        .map((observation) => ({ path: observation.key.slice("vault:".length), heads: [...observation.heads] }));
      for (const remote of remoteDeletes) {
        this.repositoryOperation.throwIfAborted("vault");
        const previewDecision = decisionByPath.get(remote.path)?.decision;
        if (previewDecision === "ignored" || previewDecision === "unknown" || previewDecision === "conflict") {
          skipped += 1;
          continue;
        }
        if (this.data.v1DirtyIntents[remote.path] || latestVaultEvent(this.data.v1VaultEvents, remote.path)
          || localConcurrentRecordBlocksAutomaticWork(this.data.v1LocalConcurrentRecords[remote.path])) {
          skipped += 1;
          continue;
        }
        const existing = this.app.vault.getAbstractFileByPath(remote.path);
        if (existing === null) {
          delete this.data.files[remote.path];
          this.data.v1ProjectedHeads[remote.path] = [...remote.heads];
          delete this.data.v1PendingApply[remote.path];
          continue;
        }
        if (!(existing instanceof TFile)) {
          replaceDecision({ path: remote.path, decision: "unknown", reason: "墓碑目标被非文件条目占用" });
          skipped += 1;
          continue;
        }
        const candidate: RemoteVaultConflictCandidate = { kind: "delete", versionId: remote.heads[0] };
        const plan = this.buildVaultApplyPlan(state, remote.path, remote.heads, { kind: "delete" });
        const result = await this.createVaultApplicator(state, { heads: remote.heads, candidate }).apply(plan);
        if (result.status === "accounted" || result.status === "adopted-without-write") deleted += 1;
        else {
          replaceDecision({
            path: remote.path,
            decision: result.status === "local-change-frozen" ? "conflict" : "unknown",
            reason: safeApplyResultMessage(result.status),
          });
          skipped += 1;
        }
      }
      syncStage = "local-persistence";
      return this.finishV1Pull(decisions, { created, updated, deleted, skipped }, notify);
    } catch (error) {
      const stagedError = withSyncFlowStage("pull", syncStage, error);
      if (notify) this.recordOperationalError(stagedError, true);
      logSafeError("S3 Sync Vault pull failed", stagedError);
      return { status: "failed", error: stagedError };
    } finally {
      if (notify) this.endRepositoryOperation("vault");
    }
  }

  private async inspectAndMaterializeVaultV1(
    state: NonNullable<S3SyncData["v1"]>,
    service: V1RepositoryService,
  ): Promise<{
    state: NonNullable<S3SyncData["v1"]>;
    pulled: V1VaultPullDiagnostics;
    decisions: PathDecisionRecord[];
    materializedConflicts: number;
  }> {
    let pulled: V1VaultPullDiagnostics;
    try {
      this.updateOperationalStatus({ phase: "pulling" });
      pulled = await service.listResolvedVaultPutsWithDiagnostics(state.repositoryId, state.descriptorHash);
    } catch (error) {
      throw withSyncFlowStage("pull", "remote-list", error);
    }
    try {
      this.updateOperationalStatus({ phase: "merging" });
      state = await this.persistObservedRemoteState(
        state,
        pulled.acceptedCommits,
        pulled.blockedCommitKeys.length === 0 ? pulled.observations : undefined,
      );
    } catch (error) {
      throw withSyncFlowStage("pull", "remote-state-persistence", error);
    }
    let decisions: PathDecisionRecord[];
    try {
      decisions = await this.buildV1PathDecisions(state, pulled);
      this.updateOperationalStatus({ decisions });
    } catch (error) {
      throw withSyncFlowStage("pull", "path-planning", error);
    }
    let materializedConflicts: number;
    try {
      materializedConflicts = await this.materializeV1ConflictCandidates(state, service, pulled, decisions);
      await this.saveSyncData();
    } catch (error) {
      throw withSyncFlowStage("pull", "local-apply", error);
    }
    if (pulled.blockedCommitKeys.length > 0) {
      if (Object.values(this.data.conflicts).some((conflict) => !conflict.resolved)) new ConflictModal(this).open();
      throw withSyncFlowStage("pull", "remote-list", pulled.blockedCommitKeys[0].reason);
    }
    return { state, pulled, decisions, materializedConflicts };
  }

  private async materializeV1ConflictCandidates(
    state: NonNullable<S3SyncData["v1"]>,
    service: V1RepositoryService,
    pulled: V1VaultPullDiagnostics,
    decisions: readonly PathDecisionRecord[],
  ): Promise<number> {
    const decisionByPath = new Map(decisions.map((decision) => [decision.path, decision.decision]));
    const activeConcurrentPaths = new Set<string>();
    let materialized = 0;

    for (const remote of pulled.conflicts) {
      if (decisionByPath.get(remote.path) === "ignored") continue;
      activeConcurrentPaths.add(remote.path);
      const existing = getTFile(this.app.vault, remote.path);
      const capture = existing ? await this.captureVaultFileHash(remote.path) : undefined;
      const id = this.recordV1ConcurrentConflict(
        remote.path,
        this.data.files[remote.path]?.hash ?? null,
        capture?.hash ?? null,
        remote.heads,
        remote.candidates,
      );
      await this.saveSyncData();
      await this.materializeConflictCopies(state, service, id, remote.path, remote.candidates);
      materialized += 1;
    }

    for (const remote of pulled.files) {
      if (decisionByPath.get(remote.path) !== "conflict" || activeConcurrentPaths.has(remote.path)) continue;
      const existing = getTFile(this.app.vault, remote.path);
      const capture = existing ? await this.captureVaultFileHash(remote.path) : undefined;
      const id = this.recordV1Conflict(
        remote.path,
        this.data.files[remote.path]?.hash ?? null,
        capture?.hash ?? null,
        remote.hash,
        remote.size,
        remote.heads,
      );
      await this.saveSyncData();
      await this.materializeConflictCopies(
        state,
        service,
        id,
        remote.path,
        remote.heads.map((versionId) => ({
          kind: "put" as const,
          versionId,
          hash: remote.hash,
          size: remote.size,
        })),
      );
      materialized += 1;
    }

    for (const observation of pulled.observations) {
      if (!observation.key.startsWith("vault:") || observation.disposition !== "resolved"
        || observation.valueHash !== null || observation.heads.length === 0) continue;
      const path = observation.key.slice("vault:".length);
      if (decisionByPath.get(path) !== "conflict") continue;
      const existing = getTFile(this.app.vault, path);
      const capture = existing ? await this.captureVaultFileHash(path) : undefined;
      this.recordV1ResolvedDeleteConflict(
        path,
        this.data.files[path]?.hash ?? null,
        capture?.hash ?? null,
        observation.heads,
      );
      materialized += 1;
    }

    for (const conflict of Object.values(this.data.conflicts)) {
      if (!conflict.resolved && conflict.remoteDisposition === "concurrent"
        && !activeConcurrentPaths.has(conflict.path)) conflict.resolved = true;
    }
    return materialized;
  }

  private async materializeConflictCopies(
    state: NonNullable<S3SyncData["v1"]>,
    service: V1RepositoryService,
    conflictIdValue: string,
    logicalPath: string,
    candidates: readonly RemoteVaultConflictCandidate[],
  ): Promise<void> {
    const downloaded = new Map<string, Uint8Array>();
    for (const candidate of candidates) {
      if (candidate.kind !== "put") continue;
      const contentKey = `${candidate.hash}:${candidate.size}`;
      let bytes = downloaded.get(contentKey);
      if (!bytes) {
        bytes = await service.downloadVaultBlob(state.repositoryId, candidate);
        downloaded.set(contentKey, bytes);
      }
      await this.writeConflictCopy(
        conflictVersionCopyPath(conflictIdValue, candidate.versionId, logicalPath),
        bytes,
        candidate,
      );
    }
  }

  private async writeConflictCopy(
    path: string,
    bytes: Uint8Array,
    expected: { hash: string; size: number },
  ): Promise<void> {
    if (!conflictCopyContentMatches(bytes, expected)) {
      throw new DiagnosticError(
        "CONFLICT_COPY_SOURCE_MISMATCH",
        "integrity",
        "downloaded conflict candidate does not match its verified Hash and size",
      );
    }
    if (this.app.vault.getAbstractFileByPath(path)) {
      await this.assertConflictCopyContent(path, expected);
      return;
    }
    await ensureParentFolder(this.app.vault, path);
    try {
      await this.app.vault.createBinary(path, toArrayBuffer(bytes));
    } catch (error) {
      if (!this.app.vault.getAbstractFileByPath(path)) throw error;
    }
    await this.assertConflictCopyContent(path, expected);
  }

  private async assertConflictCopyContent(
    path: string,
    expected: { hash: string; size: number },
  ): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (!(existing instanceof TFile)) {
      throw new DiagnosticError(
        "CONFLICT_COPY_PATH_OCCUPIED",
        "local-path",
        "conflict candidate path is occupied by a non-file entry",
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await this.app.vault.readBinary(existing));
    } catch (cause) {
      throw new DiagnosticError(
        "CONFLICT_COPY_READ_FAILED",
        "local-path",
        "existing conflict candidate copy could not be read for verification",
        cause,
      );
    }
    if (!conflictCopyContentMatches(bytes, expected)) {
      throw new DiagnosticError(
        "CONFLICT_COPY_CONTENT_MISMATCH",
        "local-path",
        "existing conflict candidate copy was changed and cannot represent the verified remote version",
      );
    }
  }

  private v1PullBlockSummary(decisions: readonly PathDecisionRecord[]): { conflicts: number; pending: number } {
    const conflictPaths = new Set([
      ...decisions.filter((decision) => decision.decision === "conflict").map((decision) => decision.path),
      ...Object.values(this.data.conflicts).filter((conflict) => !conflict.resolved).map((conflict) => conflict.path),
    ]);
    const pendingPaths = new Set(decisions
      .filter((decision) => decision.decision === "unknown" && !conflictPaths.has(decision.path))
      .map((decision) => decision.path));
    return { conflicts: conflictPaths.size, pending: pendingPaths.size };
  }

  private async finishV1Pull(
    decisions: PathDecisionRecord[],
    counts: V1PullCounts,
    notify: boolean,
  ): Promise<V1OperationResult> {
    decisions.sort((left, right) => compareUtf8(left.path, right.path));
    const blocked = this.v1PullBlockSummary(decisions);
    this.updateOperationalStatus({
      decisions,
      lastSuccessfulPull: Date.now(),
      ...(notify ? { phase: "idle" as const } : {}),
    });
    await this.saveSyncData();
    if (notify) {
      new Notice(blocked.conflicts > 0 || blocked.pending > 0
        ? `S3 Sync：检查完成；新增 ${counts.created}，更新 ${counts.updated}，删除 ${counts.deleted}，冲突 ${blocked.conflicts}，待处理 ${blocked.pending}，已跳过 ${counts.skipped}。`
        : `S3 Sync：拉取完成；新增 ${counts.created}，更新 ${counts.updated}，删除 ${counts.deleted}，已跳过 ${counts.skipped}。`);
    }
    if (blocked.conflicts > 0 && Object.values(this.data.conflicts).some((conflict) => !conflict.resolved)) {
      new ConflictModal(this).open();
    } else if (blocked.pending > 0) {
      new SyncDashboardModal(this).open();
    }
    return blocked.conflicts > 0 || blocked.pending > 0
      ? { status: "blocked", conflicts: blocked.conflicts, pending: blocked.pending }
      : { status: "success" };
  }

  async runDesktopRuntimeContract(): Promise<void> {
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
      showCopyableErrorNotice("S3 Sync：运行环境检查失败", error, "runtime-contract");
      logSafeError("S3 Sync runtime contract failed", error);
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

  private async activateRepository(locator: RepositoryLocator, repository: DiscoveredRepository): Promise<void> {
    this.repositoryState.clear();
    this.data.v1 = {
      ...createPersistedRepositoryBinding(
        locator,
        repository.repositoryId,
        repository.descriptorHash,
        repository.configDir,
        repository.historicalConfigDirs,
      ),
      writerFrontiers: {},
      writerId: crypto.randomUUID(),
      nextSequence: "00000000000000000001",
      previousCommitHash: null,
    };
    const restored = await this.repositoryState.restore(this.data);
    this.applyRepositoryStateRestoreResult(restored);
    this.markRepositoryVerified();
    await this.savePluginData();
    this.updateStatus();
  }

  private applyRepositoryStateRestoreResult(restored: RepositoryStateRestoreResult): void {
    if (restored.status === "restored" && restored.configProfile) {
      this.settings.configProfile = restored.configProfile;
      return;
    }
    if (restored.status !== "archived-and-reset") return;
    const message = `本地仓库状态损坏或格式不受支持；已归档 ${restored.archivedCopies} 个状态副本并建立新的本地 writer。S3 与暂存/恢复文件均未删除。`;
    this.data.v1OperationalStatus = {
      ...this.data.v1OperationalStatus,
      lastError: this.operationalError("local-path", message, "durable-state-restore", restored.error),
    };
    showCopyableNotice(message, safeGenericErrorReport(restored.error, "durable-state-restore"));
  }

  private async assertV1RepositoryBinding(state: NonNullable<S3SyncData["v1"]>): Promise<void> {
    assertPersistedRepositoryBinding(state, this.currentV1Locator(this.getEffectivePrefix()), this.app.vault.configDir, state.historicalConfigDirs);
    await this.createRepositoryService(this.settings, state.locator.normalizedPrefix).assertDescriptorBinding(state.repositoryId, state.descriptorHash, state);
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
      void this.vaultEvents.handleUpsert(path)
        .catch((error) => this.reportBackgroundError("Vault 新建事件处理失败", error, "vault-create-event"));
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (!(file instanceof TFile)) return;
      const path = normalizePath(file.path);
      void this.vaultEvents.handleUpsert(path)
        .catch((error) => this.reportBackgroundError("Vault 修改事件处理失败", error, "vault-modify-event"));
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      this.runBackgroundAction("Vault 删除事件处理失败", "vault-delete-event", () => {
        if (!(file instanceof TFile)) return;
        this.vaultEvents.handleDelete(normalizePath(file.path));
      });
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      this.runBackgroundAction("Vault 重命名事件处理失败", "vault-rename-event", () => {
        if (!(file instanceof TFile)) return;
        this.vaultEvents.handleRename(normalizePath(oldPath), normalizePath(file.path));
      });
    }));
  }

  private isV1ManagedVaultPath(path: string): boolean {
    const state = this.data.v1;
    return !!state
      && !isVaultPathExcluded(path, this.app.vault.configDir, state.historicalConfigDirs)
      && !isIgnored(path, parseIgnorePatterns(this.settings.ignoredPatterns));
  }

  private queueCausalStatePersistence(): void {
    this.causalStatePersistence = this.causalStatePersistence
      .then(() => this.savePluginData())
      .catch((error) => this.reportBackgroundError("后台同步状态保存失败", error, "causal-state-persistence"));
  }

  reportBackgroundError(label: string, error: unknown, context = "background"): void {
    const record = safeErrorRecord(error);
    const message = this.errorMessage(error);
    const report = safeGenericErrorReport(error, context);
    this.updateOperationalStatus({
      phase: this.repositoryOperation.isRunning() ? this.data.v1OperationalStatus.phase : "read-only",
      lastError: {
        category: record.category,
        message,
        report,
        syncStage: context,
      },
    });
    showCopyableNotice(`S3 Sync：${label}：${message}`, report);
    logSafeError(`S3 Sync ${context}`, error);
  }

  private reportActionBlocker(
    code: string,
    category: SyncDiagnosticCategory,
    message: string,
    context: string,
    notify = true,
  ): void {
    const error = new DiagnosticError(code, category, message);
    const report = safeGenericErrorReport(error, context);
    this.updateOperationalStatus({
      lastError: { category, message, report, syncStage: context },
    });
    if (notify) showCopyableNotice(`S3 Sync：${message}`, report);
  }

  private runBackgroundAction(label: string, context: string, action: () => void | Promise<void>): void {
    try {
      const pending = action();
      if (pending) void pending.catch((error) => this.reportBackgroundError(label, error, context));
    } catch (error) {
      this.reportBackgroundError(label, error, context);
    }
  }

  private stopSchedulingAndFlush(): void {
    this.autoSyncScheduler?.suspend();
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.queueCausalStatePersistence();
  }

  private updateStatus(): void {
    if (!this.statusEl) {
      return;
    }
    this.statusEl.setText(operationalStatusBarText(this.getOperationalStatus()));
  }

  private updateOperationalStatus(patch: Partial<OperationalStatus>): void {
    this.data.v1OperationalStatus = { ...this.data.v1OperationalStatus, ...patch };
    this.updateStatus();
  }

  private recordOperationalError(error: unknown, allowAutoRetry = false): void {
    const record = safeErrorRecord(error);
    const category: SyncDiagnosticCategory = record.category;
    const message = this.errorMessage(error);
    const report = safeSyncErrorReport(error);
    const identityInvalid = category === "repository-identity" && record.syncStage !== "preflight";
    const manualRecovery = hasManualRecoveryBlocker(this.getOperationalStatus());
    this.updateOperationalStatus({
      phase: manualRecovery || identityInvalid ? "read-only" : "idle",
      retryAt: undefined,
      lastError: {
        category,
        message,
        report,
        syncStage: record.syncStage,
        connectionStage: record.connectionStage,
      },
      repositoryIdentityValid: this.data.v1OperationalStatus.repositoryIdentityValid && !identityInvalid,
    });
    if (allowAutoRetry && this.settings.autoSync && (category === "network" || category === "rate-limit")) {
      this.scheduleV1Retry();
    } else {
      if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.updateOperationalStatus({ retryAt: undefined, retryAttempt: 0 });
    }
    this.queueCausalStatePersistence();
    showCopyableNotice(`S3 Sync：${message}`, report);
  }

  private scheduleV1Retry(): void {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    const attempt = this.data.v1OperationalStatus.retryAttempt + 1;
    const delay = retryDelayMs(attempt - 1);
    const retryAt = Date.now() + delay;
    this.updateOperationalStatus({ phase: "waiting-retry", retryAttempt: attempt, retryAt });
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.updateOperationalStatus({ retryAt: undefined });
      void this.runV1SyncRound(true);
    }, delay);
  }

  private deferV1Retry(): void {
    if (!this.settings.autoSync) return;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    const delay = 1_000;
    this.updateOperationalStatus({ retryAt: Date.now() + delay });
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.updateOperationalStatus({ retryAt: undefined });
      void this.runV1SyncRound(true);
    }, delay);
  }

  private cancelV1Retry(resetState: boolean): void {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (!resetState) return;
    const phase = this.data.v1OperationalStatus.phase === "waiting-retry" ? "idle" : this.data.v1OperationalStatus.phase;
    this.updateOperationalStatus({ phase, retryAt: undefined, retryAttempt: 0 });
  }

  private resumeV1RetrySchedule(): void {
    const status = this.data.v1OperationalStatus;
    const retryable = status.lastError?.category === "network" || status.lastError?.category === "rate-limit";
    if (!this.settings.autoSync || !retryable || status.retryAt === undefined || !Number.isFinite(status.retryAt)
      || !mayRunMutatingSync(this.getOperationalStatus())) {
      if (status.retryAt !== undefined && !this.settings.autoSync) this.cancelV1Retry(true);
      return;
    }
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    const delay = Math.max(0, Math.min(60_000, status.retryAt - Date.now()));
    this.updateOperationalStatus({ phase: "waiting-retry" });
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.updateOperationalStatus({ retryAt: undefined });
      void this.runV1SyncRound(true);
    }, delay);
  }

  private async loadPluginData(): Promise<void> {
    const defaultData = createDefaultData();
    const persisted = await this.loadData();
    let selectedRepository: S3SyncData["v1"];
    if (persisted === null) {
      this.settings = structuredClone(DEFAULT_SETTINGS);
    } else {
      try {
        const decoded = decodePluginData(persisted);
        this.settings = decoded.settings;
        selectedRepository = decoded.repositorySelection
          ? {
            ...decoded.repositorySelection,
            writerFrontiers: {},
            writerId: crypto.randomUUID(),
            nextSequence: "00000000000000000001",
            previousCommitHash: null,
          }
          : undefined;
      } catch (error) {
        this.settings = structuredClone(DEFAULT_SETTINGS);
        this.data = defaultData;
        this.data.v1OperationalStatus = {
          ...this.data.v1OperationalStatus,
          phase: "read-only",
          repositoryIdentityValid: false,
          lastError: this.operationalError(
            "local-path",
            "本地插件配置格式无效；已安全回到未连接状态。原文件和仓库状态目录均未删除。",
            "plugin-data-load",
            error,
          ),
        };
        showCopyableErrorNotice("S3 Sync：插件配置读取失败", error, "plugin-data-load");
        return;
      }
    }
    selectedRepository = selectedRepository
      ? {
        ...selectedRepository,
      }
      : undefined;
    if (selectedRepository) {
      assertPersistedRepositoryBinding(
        selectedRepository,
        selectedRepository.locator,
        this.app.vault.configDir,
        selectedRepository.historicalConfigDirs,
      );
    }
    this.data = { ...defaultData, v1: selectedRepository };
    try {
      const restored = await this.repositoryState.restore(this.data);
      this.applyRepositoryStateRestoreResult(restored);
    } catch (error) {
      this.data.v1OperationalStatus = {
        ...this.data.v1OperationalStatus,
        phase: "read-only",
        recoveryBlockers: [{
          code: "repository-state",
          source: "repository-state",
          disposition: "manual",
          message: "本地仓库状态读取失败；修复本地存储并重新加载插件后可自动重试。",
        }],
        lastError: this.operationalError(
          "local-path",
          "本地仓库状态读取失败；为避免覆盖因果状态，本次不会访问 S3。",
          "durable-state-restore",
          error,
        ),
      };
      showCopyableErrorNotice("S3 Sync：本地仓库状态读取失败", error, "durable-state-restore");
    }
  }

  private async savePluginData(): Promise<void> {
    try {
      await this.persistV1DurableState();
    } catch (error) {
      throw withLocalPersistenceStep("durable-state", error);
    }
    const state = this.data.v1;
    const envelope = encodePluginData(this.settings, state);
    try {
      assertPluginDataContainsNoOperationalState(envelope);
    } catch (error) {
      throw withLocalPersistenceStep("plugin-data-validation", error);
    }
    try {
      await this.saveData(envelope);
    } catch (error) {
      throw withLocalPersistenceStep("plugin-data-write", error);
    }
  }

  private async persistV1DurableState(): Promise<void> {
    await this.repositoryState.persist(this.data);
  }

  private async v1DurableStore(state: NonNullable<S3SyncData["v1"]>): Promise<DurableStateStore<StateJsonValue>> {
    return this.repositoryState.store(state);
  }

  private recordV1Conflict(
    path: string,
    baseHash: string | null,
    localHash: string | null,
    remoteHash: string,
    remoteSize: number,
    remoteHeads: string[],
  ): string {
    return this.recordV1RemoteConflict({
      path,
      baseHash,
      localHash,
      disposition: "resolved",
      heads: remoteHeads,
      candidates: remoteHeads.map((versionId) => ({
        kind: "put",
        versionId,
        hash: remoteHash,
        size: remoteSize,
      })),
    });
  }

  private recordV1ResolvedDeleteConflict(
    path: string,
    baseHash: string | null,
    localHash: string | null,
    remoteHeads: string[],
  ): string {
    return this.recordV1RemoteConflict({
      path,
      baseHash,
      localHash,
      disposition: "resolved",
      heads: remoteHeads,
      candidates: remoteHeads.map((versionId) => ({ kind: "delete", versionId })),
    });
  }

  private recordV1ConcurrentConflict(
    path: string,
    baseHash: string | null,
    localHash: string | null,
    remoteHeads: string[],
    candidates: RemoteVaultConflictCandidate[],
  ): string {
    return this.recordV1RemoteConflict({
      path,
      baseHash,
      localHash,
      disposition: "concurrent",
      heads: remoteHeads,
      candidates,
    });
  }

  private recordV1RemoteConflict(input: {
    path: string;
    baseHash: string | null;
    localHash: string | null;
    disposition: "resolved" | "concurrent";
    heads: string[];
    candidates: RemoteVaultConflictCandidate[];
  }): string {
    const id = conflictId(this.data.v1?.repositoryId ?? "unknown", "vault", [input.path], input.heads);
    for (const [existingId, existing] of Object.entries(this.data.conflicts)) {
      if (existingId !== id && !existing.resolved && existing.path === input.path) delete this.data.conflicts[existingId];
    }
    const detectedAt = this.data.conflicts[id]?.detectedAt ?? new Date().toISOString();
    this.data.conflicts[id] = {
      id,
      path: input.path,
      baseHash: input.baseHash,
      localHash: input.localHash,
      remoteDisposition: input.disposition,
      remoteHeads: [...input.heads],
      remoteCandidates: input.candidates.map((candidate) => ({ ...candidate })),
      detectedAt,
      resolved: false,
    };
    return id;
  }

  private async resolveV1Conflict(
    conflict: S3SyncData["conflicts"][string],
    mode: "local" | "remote",
    remoteVersionId?: string,
  ): Promise<void> {
    let state = this.data.v1;
    if (!state) throw new Error("repository is not connected");
    await this.assertV1RepositoryBinding(state);
    await this.drainDurableOutboxIfPresent(state);
    state = this.data.v1!;
    const service = this.createRepositoryService(this.settings, state.locator.normalizedPrefix);
    const pulled = await service.inspectVaultRegisterWithAnchors(state.repositoryId, state.descriptorHash, conflict.path);
    state = await this.persistObservedRemoteState(state, pulled.acceptedCommits, pulled.observations);
    const remote = pulled.register;
    if (!sameHeads(remote.heads, conflict.remoteHeads)) throw new Error("remote conflict changed; refresh before resolving");
    const concurrent = conflict.remoteDisposition === "concurrent";
    if (remote.disposition !== conflict.remoteDisposition
      || !sameRemoteConflictCandidates(remote.candidates, conflict.remoteCandidates)) {
      throw new Error("remote conflict changed; refresh before resolving");
    }
    if (mode === "remote") {
      const candidate = concurrent
        ? remote.candidates.find((item) => item.versionId === remoteVersionId)
        : remote.candidates.find((item) => item.versionId === remoteVersionId) ?? remote.candidates[0];
      if (!candidate || (concurrent && !remoteVersionId)) throw new Error("select a remote conflict candidate first");
      const local = this.app.vault.getAbstractFileByPath(conflict.path);
      if (local !== null && !(local instanceof TFile)) throw new Error("local conflict path is occupied by a non-file entry");
      const localCapture = local instanceof TFile ? await this.captureVaultFileHash(conflict.path) : undefined;
      if (local instanceof TFile && !localCapture) throw new Error("local conflict content changed during before-image capture");
      const expectedLocal: BoundApplyPlan["expectedLocal"] = localCapture
        ? { kind: "present", hash: localCapture.hash, size: localCapture.size }
        : { kind: "absent" };
      const eventGeneration = latestVaultEvent(this.data.v1VaultEvents, conflict.path)?.generation ?? 0;
      const dirtyGeneration = this.data.v1DirtyIntents[conflict.path]?.generation ?? 0;
      const captureGeneration = Math.max(
        dirtyGeneration,
        eventGeneration,
        this.data.v1VaultGenerations[conflict.path] ?? 0,
      );
      let target: BoundApplyPlan["target"];
      if (candidate.kind === "delete") {
        target = { kind: "delete" };
      } else {
        const bytes = await service.downloadVaultBlob(state.repositoryId, candidate);
        const staged = await this.repositoryContentStaging(state).stage(oneChunk(bytes), candidate.size);
        target = {
          kind: "put",
          hash: candidate.hash,
          size: candidate.size,
          stagedRef: `${localStateRoot(state.configDir, state.repositoryId)}/${staged.ref}`,
        };
      }
      const plan = this.buildVaultApplyPlan(state, conflict.path, remote.heads, target, expectedLocal);
      const applyResult = await this.createVaultApplicator(
        state,
        { heads: remote.heads, candidate },
        conflict.path,
        expectedLocal,
      ).apply(plan);
      if (applyResult.status !== "accounted" && applyResult.status !== "adopted-without-write") {
        throw new DiagnosticError(
          `CONFLICT_APPLY_${applyResult.status.toUpperCase().replace(/-/g, "_")}`,
          applyResult.status === "local-change-frozen" ? "conflict" : "local-path",
          "selected conflict candidate could not be applied safely",
        );
      }

      if (concurrent && candidate.kind === "delete") {
        const published = await this.freezePublishAndReconcileVaultDelete({
          state,
          path: conflict.path,
          parents: remote.heads,
          captureGeneration,
        });
        delete this.data.files[conflict.path];
        this.data.v1ProjectedHeads[conflict.path] = [published.versionId];
        delete this.data.v1PendingApply[conflict.path];
      } else if (concurrent && candidate.kind === "put") {
        const capture = await this.captureVaultFileToStaging(state, conflict.path);
        if (capture.status !== "captured" || capture.hash !== candidate.hash || capture.size !== candidate.size) {
          throw new Error("selected remote conflict candidate changed during local capture");
        }
        const published = await this.freezePublishAndReconcileVaultPut({
          state,
          path: conflict.path,
          parents: remote.heads,
          capture,
          captureGeneration,
        });
        this.data.v1ProjectedHeads[conflict.path] = [published.versionId];
      } else {
        delete this.data.v1DirtyIntents[conflict.path];
        this.data.v1VaultEvents = clearVaultEventsThroughGeneration(
          this.data.v1VaultEvents,
          conflict.path,
          eventGeneration,
        );
      }
    } else {
      const capture = await this.captureVaultFileToStaging(state, conflict.path);
      if (capture.status !== "captured" || capture.hash !== conflict.localHash) {
        throw new Error(capture.status === "captured"
          ? "local conflict content changed; refresh before resolving"
          : vaultCaptureFailureMessage(conflict.path, capture));
      }
      const published = await this.freezePublishAndReconcileVaultPut({
        state,
        path: conflict.path,
        parents: remote.heads,
        capture,
        captureGeneration: Math.max(
          this.data.v1DirtyIntents[conflict.path]?.generation ?? 0,
          latestVaultEvent(this.data.v1VaultEvents, conflict.path)?.generation ?? 0,
          this.data.v1VaultGenerations[conflict.path] ?? 0,
        ),
      });
      this.data.files[conflict.path] = { hash: capture.hash, size: capture.size, updatedAt: new Date().toISOString() };
      this.data.v1ProjectedHeads[conflict.path] = [published.versionId];
      delete this.data.v1PendingApply[conflict.path];
    }
    this.data.conflicts[conflict.id] = { ...conflict, resolved: true };
    await this.saveSyncData();
  }

  private configWorkspaceRuntime(state: NonNullable<S3SyncData["v1"]>): ConfigWorkspaceRuntime {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error("配置应用需要桌面 FileSystemAdapter；当前平台只能预览");
    return createConfigWorkspaceRuntime({ adapter, configDir: state.configDir, repositoryId: state.repositoryId });
  }

  private repositoryContentStaging(state: NonNullable<S3SyncData["v1"]>): ImmutableContentStaging {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error("大文件暂存需要桌面 FileSystemAdapter");
    return new ImmutableContentStaging(new NodeContentStagingAdapter(
      adapter.getFullPath(localStateRoot(state.configDir, state.repositoryId)),
    ));
  }

  private createVaultApplicator(
    state: NonNullable<S3SyncData["v1"]>,
    remote: { heads: string[]; candidate: RemoteVaultConflictCandidate },
    allowConflictPath?: string,
    conflictExpectedLocal?: BoundApplyPlan["expectedLocal"],
  ): SafeLocalApplicator {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error("Vault 安全应用需要桌面 FileSystemAdapter");
    const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
    const files = new NodeLocalFileAdapter({ root: adapter.getBasePath(), platform, domain: "vault", eventsObservable: true });
    const staging = this.repositoryContentStaging(state);
    const stateRoot = localStateRoot(state.configDir, state.repositoryId);

    return new SafeLocalApplicator(files, {
      guard: async (path) => {
        const projected = this.data.files[path];
        const generation = this.data.v1VaultGenerations[path] ?? 0;
        const event = latestVaultEvent(this.data.v1VaultEvents, path);
        return {
          repositoryFingerprint: this.data.v1?.repositoryFingerprint ?? "missing",
          observedHeads: [...(this.data.v1ObservedRegisters[`vault:${path}`]?.heads ?? [])],
          projectedHeads: [...(this.data.v1ProjectedHeads[path] ?? [])],
          projectedValue: path === allowConflictPath && conflictExpectedLocal
            ? { ...conflictExpectedLocal }
            : projected
              ? { kind: "present" as const, hash: projected.hash, size: projected.size }
              : { kind: "absent" as const },
          projectionGeneration: generation,
          dirtyGeneration: Math.max(generation, this.data.v1DirtyIntents[path]?.generation ?? 0, event?.generation ?? 0),
          hasDirtyIntent: path === allowConflictPath
            ? false
            : this.data.v1DirtyIntents[path] !== undefined || event !== undefined,
          hasDirtyRecord: false,
          hasLocalConcurrentRecord: path === allowConflictPath
            ? false
            : localConcurrentRecordBlocksAutomaticWork(this.data.v1LocalConcurrentRecords[path]),
        };
      },
      persistJournal: async (journal) => {
        const existing = this.data.v1ApplyJournals.findIndex((candidate) => candidate.operationId === journal.operationId);
        if (existing >= 0) this.data.v1ApplyJournals[existing] = structuredClone(journal);
        else this.data.v1ApplyJournals.push(structuredClone(journal));
        this.v1ApplyOperations.set(journal.path, journal.operationId);
        await this.savePluginData();
      },
      persistRecovery: async (record: RecoveryRecord) => {
        this.data.v1RecoveryRecords[record.id] = structuredClone(record);
        await this.savePluginData();
      },
      freezeLocalChange: async (path, observed) => {
        if (remote.candidate.kind === "put") {
          this.recordV1Conflict(
            path,
            this.data.files[path]?.hash ?? null,
            observed.kind === "present" ? observed.hash : null,
            remote.candidate.hash,
            remote.candidate.size,
            remote.heads,
          );
        } else {
          this.recordV1ConcurrentConflict(
            path,
            this.data.files[path]?.hash ?? null,
            observed.kind === "present" ? observed.hash : null,
            remote.heads,
            [remote.candidate],
          );
        }
        await this.savePluginData();
      },
      accountProjection: async (plan, after) => {
        if (after.kind === "present") {
          this.data.files[plan.path] = { hash: after.hash, size: after.size, updatedAt: new Date().toISOString() };
        } else {
          delete this.data.files[plan.path];
        }
        this.data.v1ProjectedHeads[plan.path] = [...plan.targetHeads];
        delete this.data.v1PendingApply[plan.path];
        this.data.v1ApplyJournals = this.data.v1ApplyJournals.filter((journal) => journal.operationId !== plan.operationId);
        if (this.v1ApplyOperations.get(plan.path) === plan.operationId) this.v1ApplyOperations.delete(plan.path);
        await this.savePluginData();
      },
    }, {
      now: () => Date.now(),
      recoveryRef: (plan) => `${stateRoot}/recovery/${plan.operationId}`,
      conservativeCandidateRef: (plan) => `${stateRoot}/conflict-drafts/${plan.operationId}`,
      verifyStaged: async (target) => {
        const prefix = `${stateRoot}/`;
        if (!target.stagedRef.startsWith(prefix)) throw new Error("staged Vault target belongs to another state root");
        await staging.verify(target.stagedRef.slice(prefix.length), { hash: target.hash, size: target.size });
      },
    });
  }

  private buildVaultApplyPlan(
    state: NonNullable<S3SyncData["v1"]>,
    path: string,
    heads: string[],
    target: BoundApplyPlan["target"],
    expectedLocal?: BoundApplyPlan["expectedLocal"],
  ): BoundApplyPlan {
    const projected = this.data.files[path];
    const generation = this.data.v1VaultGenerations[path] ?? 0;
    const eventGeneration = latestVaultEvent(this.data.v1VaultEvents, path)?.generation ?? 0;
    const dirtyGeneration = this.data.v1DirtyIntents[path]?.generation ?? 0;
    return {
      operationId: crypto.randomUUID(),
      path,
      repositoryFingerprint: state.repositoryFingerprint,
      targetHeads: [...heads],
      projectedHeads: [...(this.data.v1ProjectedHeads[path] ?? [])],
      target,
      expectedLocal: expectedLocal ?? (projected
        ? { kind: "present", hash: projected.hash, size: projected.size }
        : { kind: "absent" }),
      projectionGeneration: generation,
      dirtyGeneration: Math.max(generation, eventGeneration, dirtyGeneration),
    };
  }

  private captureVaultFileHash(path: string) {
    return this.vaultHashExecutor.run(() => captureStableVaultFile(this.app.vault, path));
  }

  private captureVaultFileToStaging(state: NonNullable<S3SyncData["v1"]>, path: string) {
    return this.vaultHashExecutor.run(() => captureStableVaultFileToStaging(
      this.app.vault,
      path,
      this.repositoryContentStaging(state),
    ));
  }

  private recordConfigUiState(status: PersistedConfigSyncState["status"], lastError?: string, recoveryLocation?: string): void {
    this.data.v1ConfigSync = {
      ...this.data.v1ConfigSync,
      status,
      ...(lastError ? { lastError } : { lastError: undefined }),
      ...(recoveryLocation ? { recoveryLocation } : {}),
    };
  }

  private errorMessage(error: unknown): string {
    return safeErrorMessage(error);
  }

  private operationalError(
    category: SyncDiagnosticCategory,
    message: string,
    stage: string,
    error?: unknown,
  ): OperationalStatus["lastError"] {
    return {
      category,
      message,
      report: error === undefined
        ? JSON.stringify({ type: "s3-sync-error", schemaVersion: 3, code: `S3SYNC_${stage.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`, category, message }, null, 2)
        : safeSyncErrorReport(error),
      syncStage: stage,
    };
  }
}

function sameHeads(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((head, index) => head === normalizedRight[index]);
}

function safeApplyResultMessage(status: string): string {
  return {
    "local-change-frozen": "应用前检测到新的本地内容，已保留双方并转为冲突",
    "stale-plan": "远端头或本地 generation 已变化，需要重新检查",
    "recovery-required": "安全应用未完成，前像已保留在恢复目录",
    pending: "本地文件状态暂时无法安全确认",
    "conservative-candidate": "当前平台只能生成候选副本",
  }[status] ?? `安全应用未完成（${status}）`;
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield new Uint8Array(bytes);
}

function sameRemoteConflictCandidates(
  left: readonly RemoteVaultConflictCandidate[],
  right: readonly RemoteVaultConflictCandidate[],
): boolean {
  const identity = (candidate: RemoteVaultConflictCandidate): string => candidate.kind === "put"
    ? `${candidate.versionId}:put:${candidate.hash}:${candidate.size}`
    : `${candidate.versionId}:delete`;
  const normalizedLeft = left.map(identity).sort();
  const normalizedRight = right.map(identity).sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((candidate, index) => candidate === normalizedRight[index]);
}

function clonePayload<T>(value: StateJsonValue | undefined, fallback: T): T {
  return value === undefined ? fallback : JSON.parse(JSON.stringify(value)) as T;
}

function persistedConfigTreeItems(tree: PersistedConfigSyncState["projectedTree"]): ManagedConfigItem[] {
  return tree?.items.map((item): ManagedConfigItem => item.kind === "delete"
    ? { path: item.path, kind: "delete" }
    : {
      path: item.path,
      kind: "put",
      hash: item.blobHash!,
      size: item.size!,
      stagedRef: `projected:${item.path}`,
    }) ?? [];
}

function configProfileFromTree(tree: ProtocolConfigTree): ConfigProfile {
  const { schema: _schema, ...profile } = tree.profile;
  return structuredClone(profile);
}

function configBatchTargetItems(tree: ProtocolConfigTree, plan: ConfigBatchPlan): ManagedConfigItem[] {
  const operations = new Map(plan.operations.map((operation) => [operation.path, operation]));
  return tree.items.map((item): ManagedConfigItem => {
    if (item.kind === "delete") return { path: item.path, kind: "delete" };
    const operation = operations.get(item.path);
    const stagedRef = operation?.target.kind === "put" ? operation.target.stagedRef : `projected:${item.path}`;
    return { path: item.path, kind: "put", hash: item.blobHash!, size: item.size!, stagedRef };
  });
}

function emptyConfigCenterSnapshot(
  state: ConfigCenterSnapshot["state"],
  persisted: PersistedConfigSyncState,
): ConfigCenterSnapshot {
  return {
    state,
    remote: [],
    diff: [],
    inventory: [],
    allLocalEnabledPluginIds: [],
    projectedHeads: [...persisted.projectedHeads],
    projectedTreeHash: persisted.projectedTreeHash,
    recoveryLocation: persisted.recoveryLocation ?? "尚未建立仓库恢复位置",
    blockedDetails: [],
  };
}

function vaultCaptureFailureMessage(
  path: string,
  result: Exclude<StableStreamCaptureResult, { status: "captured" }>,
): string {
  const reason = {
    "not-file": "路径不是可读取的普通文件",
    changed: "捕获期间文件发生变化",
    "stage-corrupt": "本地暂存 Hash 校验失败",
    "too-large": "文件超过当前协议的 5 GB Blob 上限",
    "io-error": "流式读取或暂存失败",
  }[result.reason];
  return `路径 ${path} 已隔离，未加入 Outbox：${reason}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function* singleChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield new Uint8Array(bytes);
}

const utf8Encoder = new TextEncoder();
