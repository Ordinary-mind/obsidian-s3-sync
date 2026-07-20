import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("v1 plugin entrypoint contract", () => {
  it("uses typed diagnostics at every production src throw boundary", () => {
    const sourceRoot = new URL("../../src/", import.meta.url);
    const plainThrows = readdirSync(sourceRoot)
      .filter((name) => name.endsWith(".ts"))
      .flatMap((name) => {
        const source = readFileSync(new URL(name, sourceRoot), "utf8");
        return source.includes("throw new Error") ? [name] : [];
      });
    expect(plainThrows).toEqual([]);
  });

  it("ships only the current repository runtime", () => {
    const source = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");

    expect(existsSync(new URL("../../src/sync-engine.ts", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../../src/s3-remote.ts", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../../core/sync-coordinator.ts", import.meta.url))).toBe(false);
    expect(source).not.toContain("SyncEngine");
    expect(source).not.toContain("registerVaultEvents");
    expect(source).toContain("ConnectionController");
    expect(source).toContain("V1RepositoryService");
  });

  it("routes plugin publications through the durable Outbox", () => {
    const source = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
    expect(source).not.toContain(".publishVaultPut(");
    expect(source).not.toContain(".publishConfigSnapshot(");
    expect(source).toContain("freezeDurableOutboxStateTransaction(");
    expect(source).toContain("service.replayDurableOutbox(");
  });

  it("uses disk-backed stable capture and streamed Outbox replay on the desktop production path", () => {
    const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
    const service = readFileSync(new URL("../../src/v1-service.ts", import.meta.url), "utf8");
    expect(main).toContain("captureStableVaultFileToStaging(");
    expect(main).toContain("new NodeContentStagingAdapter(");
    expect(service).toContain("private readonly objectStore: S3ObjectStore");
    expect(service).toContain("store.putImmutableStream(object.key, openBody");
    expect(service).toContain("verifyVaultBlobDependencies(");
    expect(service).not.toContain("return new S3ObjectStore(");
  });

  it("validates, probes, creates or binds, and only then applies one connection transaction", () => {
    const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
    const controller = readFileSync(new URL("../../src/connection-controller.ts", import.meta.url), "utf8");
    const settings = readFileSync(new URL("../../src/settings-tab.ts", import.meta.url), "utf8");
    const copyableNotice = readFileSync(new URL("../../src/copyable-notice.ts", import.meta.url), "utf8");
    const start = controller.indexOf("async testAndApply");
    const end = controller.indexOf("private async applyCandidate", start);
    const connectionFlow = controller.slice(start, end);

    expect(main).toContain("return await this.connectionController.testAndApply(input)");
    expect(connectionFlow.indexOf("await service.probeWritableConnection")).toBeLessThan(
      connectionFlow.indexOf("await service.createRepository"),
    );
    expect(connectionFlow.indexOf("await service.createRepository")).toBeLessThan(
      connectionFlow.indexOf("return await this.applyCandidate"),
    );
    expect(controller).toContain("CONNECTION_REPOSITORY_SCOPE_AMBIGUOUS");
    expect(controller).toContain("连接成功；已自动创建并接入仓库。");
    expect(settings).toContain('.setButtonText("检测并应用")');
    expect(settings).not.toMatch(/发现并检查|选择唯一仓库|创建新仓库/);
    expect(settings.match(/\.setName\("同步 Obsidian 设置"\)/g) ?? []).toHaveLength(1);
    expect(settings).not.toContain("configSyncEnabled");
    expect(copyableNotice).toContain('setIcon(button, "copy")');
    expect(copyableNotice).toContain("safeGenericErrorReport(error, context)");
    expect(copyableNotice).toContain("COPYABLE_NOTICE_DURATION_MS = 5_000");
    expect(copyableNotice).not.toContain("new Notice(fragment, 0)");
  });

  it("exposes three low-friction commands and a one-click sync ribbon", () => {
    const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
    const onload = main.slice(main.indexOf("async onload()"), main.indexOf("onunload(): void"));

    expect(onload.match(/this\.addCommand\(\{/g) ?? []).toHaveLength(3);
    for (const name of ["S3 Sync：同步", "S3 Sync：检查并拉取", "S3 Sync：状态与检查"]) {
      expect(onload).toContain(`name: "${name}"`);
    }
    expect(onload).toContain('this.addRibbonIcon("refresh-cw", "S3 Sync：同步"');
    expect(onload).not.toMatch(/上传当前文件|创建仓库|选择仓库/);
  });

  it("uses progressive disclosure without removing advanced capabilities", () => {
    const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
    const settings = readFileSync(new URL("../../src/settings-tab.ts", import.meta.url), "utf8");
    const dashboard = readFileSync(new URL("../../src/sync-dashboard-modal.ts", import.meta.url), "utf8");
    const conflict = readFileSync(new URL("../../src/conflict-modal.ts", import.meta.url), "utf8");
    const config = readFileSync(new URL("../../src/config-center-modal.ts", import.meta.url), "utf8");

    expect(settings).toContain("private editConnection: boolean");
    expect(settings).toContain('.setButtonText("修改连接")');
    expect(settings).toContain("private showOptional = false");
    expect(settings).toContain('.setName("同步 Obsidian 设置")');
    expect(settings).toContain('.setName("Vault 文件忽略规则")');
    expect(dashboard).toContain("private showDetails = false");
    expect(dashboard).toContain('.setName("诊断与高级功能")');
    expect(dashboard).toContain("if (status.conflicts > 0)");
    expect(dashboard).toContain('label: "本地安全副本"');
    expect(dashboard).toContain('label: "管理本地副本"');
    expect(dashboard).toContain('label: "完整校验"');
    expect(conflict).toContain('.setClass("s3-sync-conflict-summary-row")');
    const primaryRow = conflict.slice(
      conflict.indexOf("private renderConflictRow"),
      conflict.indexOf("private selectedRemoteCandidate"),
    );
    expect(primaryRow.match(/row\.addButton/g) ?? []).toHaveLength(3);
    for (const label of ["左右对照", "使用本地版本", "使用远端版本"]) {
      expect(primaryRow).toContain(`"${label}"`);
    }
    expect(primaryRow.match(/\.setTooltip\(/g) ?? []).toHaveLength(3);
    expect(primaryRow).not.toContain("setIcon(");
    expect(conflict).toContain("groupRemoteConflictCandidates(");
    expect(conflict).toContain("if (groups.length > 1) this.renderRemoteChooser");
    expect(conflict).toContain("confirmDeleteResolution(");
    expect(conflict).toContain('.setName("技术详情与诊断")');
    const resolution = main.slice(main.indexOf("private async resolveV1Conflict"), main.indexOf("private configWorkspaceRuntime"));
    expect(resolution).toContain("if (conflict.localHash === null)");
    expect(resolution).toContain("await this.freezePublishAndReconcileVaultDelete({");
    expect(config).toContain('this.snapshot?.state.status === "conflict"');
    expect(config).toContain("private showProfileAdvanced = false");
    expect(config).toContain("private showPluginScope = false");
    expect(config).toContain("private showTechnicalDetails = false");
    expect(config).toContain('["merge", "解决设置冲突", "git-merge"]');
  });

  it("pulls before publishing every pending path and stops on conflicts or pending decisions", () => {
    const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
    const start = main.indexOf("private async runV1SyncRound");
    const end = main.indexOf("private async buildV1PathDecisions", start);
    const syncRound = main.slice(start, end);
    const pullIndex = syncRound.indexOf("await this.pullMissingFilesV1(false, service)");
    const blockedIndex = syncRound.indexOf('if (pull.status === "blocked")');
    const pushIndex = syncRound.indexOf("await this.publishPendingPathsV1(service)");

    expect(pullIndex).toBeGreaterThanOrEqual(0);
    expect(blockedIndex).toBeGreaterThan(pullIndex);
    expect(pushIndex).toBeGreaterThan(blockedIndex);
    expect(syncRound.slice(blockedIndex, pushIndex)).toContain("return;");
    expect(syncRound.slice(blockedIndex, pushIndex)).not.toContain("reportActionBlocker(");
    expect(syncRound).toContain("无冲突路径已自动处理");

    const publishStart = main.indexOf("private async publishPendingPathsV1");
    const publishEnd = main.indexOf("private async publishPathV1", publishStart);
    const publishPending = main.slice(publishStart, publishEnd);
    expect(publishPending).toContain("for (const path of orderedPaths)");
    expect(publishPending).toContain("await this.publishPathV1(path, service)");

    const pullStart = main.indexOf("private async pullMissingFilesV1");
    const pullEnd = main.indexOf("async runDesktopRuntimeContract", pullStart);
    const pull = main.slice(pullStart, pullEnd);
    expect(pull).toContain("return this.finishV1Pull(");
    expect(pull.match(/return this\.finishV1Pull\(/g) ?? []).toHaveLength(1);
    expect(pull).toContain("new ConflictModal(this).open()");
    expect(pull).toContain("new SyncDashboardModal(this).open()");
    expect(pull).toContain('? { status: "blocked", conflicts: blocked.conflicts, pending: blocked.pending }');
    expect(pull).toContain('"VAULT_PULL_LOCAL_APPLY_FAILED"');
    expect(pull.indexOf("await this.drainDurableOutboxIfPresent")).toBeLessThan(
      pull.indexOf("await this.routeInterruptedApplyRecovery"),
    );
    expect(pull.indexOf("await this.routeInterruptedApplyRecovery")).toBeLessThan(
      pull.indexOf("this.assertV1SyncPreflight()"),
    );
    expect(main).toContain('blocker === "apply-journal-recovery"');
    expect(main).toContain('"REMOTE_STRUCTURAL_PATH_CONFLICT"');
    expect(main.indexOf("findStructuralConflicts(occupiedPaths)")).toBeLessThan(
      main.indexOf("recordV1ConflictCandidates(pulled, decisions)"),
    );
  });

  it("revalidates stale repository identity locks before reading remote conflict candidates", () => {
    const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
    const dashboard = readFileSync(new URL("../../src/sync-dashboard-modal.ts", import.meta.url), "utf8");
    const pullStart = main.indexOf("private async pullMissingFilesV1");
    const pullEnd = main.indexOf("async runDesktopRuntimeContract", pullStart);
    const pull = main.slice(pullStart, pullEnd);
    const verification = pull.indexOf("await this.assertV1RepositoryBinding(state, service)");
    const recovery = pull.indexOf("this.recoverVerifiedRepositoryIdentityLock()");
    const remoteList = pull.indexOf("inspectAndMaterializeVaultV1");
    const syncRound = main.slice(main.indexOf("private async runV1SyncRound"), main.indexOf("private async buildV1PathDecisions"));

    expect(pull).toContain("this.assertV1InspectionPreflight()");
    expect(verification).toBeGreaterThanOrEqual(0);
    expect(recovery).toBeGreaterThan(verification);
    expect(remoteList).toBeGreaterThan(recovery);
    expect(syncRound).not.toContain("mayRunMutatingSync");
    expect(dashboard).toContain("this.plugin.canAttemptV1Sync()");
  });

  it("uses read-only remote proof to recover a terminal Outbox before listing conflict candidates", () => {
    const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
    const service = readFileSync(new URL("../../src/v1-service.ts", import.meta.url), "utf8");
    const drainStart = main.indexOf("private async drainDurableOutbox(");
    const drainEnd = main.indexOf("private async drainDurableOutboxIfPresent", drainStart);
    const drain = main.slice(drainStart, drainEnd);

    expect(drain).toContain("service.verifyTerminalDurableOutboxRemoteCopy({");
    expect(drain).toContain("confirmTerminalDurableOutboxPublishedTransaction(");
    expect(service).toContain("await verifyObjectStream(store, object.key, { hash: object.hash, size: object.size })");
    expect(service).toContain('withDurableOutboxReplayStage("terminal-remote-verify", error)');
  });

  it("records conflicts immediately and materializes verified candidate copies only when the user opens one", () => {
    const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
    const modal = readFileSync(new URL("../../src/conflict-modal.ts", import.meta.url), "utf8");
    const drainStart = main.indexOf("private async drainDurableOutboxIfPresent");
    const drainEnd = main.indexOf("private async freezePublishAndReconcileVaultPut", drainStart);
    const drain = main.slice(drainStart, drainEnd);

    expect(drain).toContain('some((entry) => entry.state !== "published")');
    expect(main).toContain('"DURABLE_OUTBOX_WRITER_MISMATCH"');
    expect(main).toContain("input.service.inspectRepositoryState(");
    expect(main).toContain("conflictCopyContentMatches(bytes, expected)");
    expect(main).toContain("await this.recordV1ConflictCandidates(pulled, decisions)");
    expect(main).toContain("await this.materializeConflictCopies(state, service, conflict.id, conflict.path, [candidate])");
    expect(main).toContain("async openConflictRecoveryCopy(");
    expect(modal).toContain('setButtonText("打开原本机副本")');
    expect(modal).toContain("openConflictRecoveryCopy(conflict.id, recoveryId)");
    expect(main).toContain("vaultConflictId(");
    expect(main).not.toContain('conflictId(this.data.v1?.repositoryId ?? "unknown", "vault", [input.path]');
    const recordStart = main.indexOf("private async recordV1ConflictCandidates");
    const recordEnd = main.indexOf("private async materializeConflictCopies", recordStart);
    expect(main.slice(recordStart, recordEnd)).not.toContain("materializeConflictCopies(");
    const materializeStart = main.indexOf("private async materializeConflictCopies");
    const materializeEnd = main.indexOf("private async writeConflictCopy", materializeStart);
    const materialize = main.slice(materializeStart, materializeEnd);
    expect(materialize).toContain('"CONFLICT_COPY_DOWNLOAD_FAILED"');
    expect(materialize).toContain('"CONFLICT_COPY_WRITE_FAILED"');
    expect(modal).toContain("openConflictCandidateCopy(conflict.id, candidate.versionId)");
    expect(main).toContain("async cleanupResolvedLocalCopies(");
    expect(main).toContain("selectCleanableRecoveryRecords({");
    expect(modal).toContain('"清理已解决副本"');
    expect(modal).toContain("不会删除当前 Vault 文件，不会删除 S3 对象或历史");
  });

  it("loads bounded whole-file conflict comparisons without adding hunk-level selection", () => {
    const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
    const modal = readFileSync(new URL("../../src/conflict-modal.ts", import.meta.url), "utf8");
    const preview = readFileSync(new URL("../../src/conflict-preview.ts", import.meta.url), "utf8");

    expect(main).toContain("async loadConflictTextComparison(");
    expect(modal).toContain('.setButtonText(activeComparison?.status === "loading"');
    expect(modal).toContain("loadConflictTextComparison(conflict.id, candidate.versionId)");
    expect(modal).toContain("当前为整文件左右对照，不标注行级增删");
    expect(preview).toContain("maximumBytes: 1024 * 1024");
    expect(preview).toContain("maximumLines: 20_000");
    expect(modal).not.toMatch(/选择.*行|选择.*段|applyHunk|selectHunk/);
  });

  it("resumes an interrupted remote conflict choice with repository-relative recovery metadata", () => {
    const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
    const resolution = main.slice(main.indexOf("private async resolveV1Conflict"), main.indexOf("private configWorkspaceRuntime"));
    const applicator = main.slice(main.indexOf("private createVaultApplicator"), main.indexOf("private buildVaultApplyPlan"));

    expect(resolution).toContain("this.interruptedConflictApplyJournal(");
    expect(resolution).toContain("rebindSafeApplyJournal(interrupted");
    expect(resolution).toContain(").resume(rebound)");
    expect(applicator).toContain('recoveryRef: (plan) => `${stateRoot}/recovery/${plan.operationId}`');
    expect(applicator).toContain('recoveryContentRef: (plan) => `recovery/${plan.operationId}`');
  });

  it("keeps startup, conflict, and configuration action failures diagnostic", () => {
    const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
    const loadStart = main.indexOf("private async loadPluginData");
    const loadEnd = main.indexOf("private async savePluginData", loadStart);
    const load = main.slice(loadStart, loadEnd);
    const conflictStart = main.indexOf("private async resolveV1Conflict");
    const conflictEnd = main.indexOf("private configWorkspaceRuntime", conflictStart);
    const conflict = main.slice(conflictStart, conflictEnd);
    const configStart = main.indexOf("private async updateConfigProfileLocked");
    const configEnd = main.indexOf("private async drainDurableOutbox", configStart);
    const config = main.slice(configStart, configEnd);

    expect(load).toContain("persisted = await this.loadData()");
    expect(load).toContain('"PLUGIN_DATA_READ_FAILED"');
    expect(load).toContain('"PLUGIN_DATA_SCHEMA_INVALID"');
    expect(load).toContain('"SAVED_REPOSITORY_BINDING_INVALID"');
    expect(load).toContain("this.enterUnboundStartupFailure(");
    expect(conflict).toContain('"CONFLICT_REMOTE_CHANGED"');
    expect(conflict).toContain('"CONFLICT_LOCAL_PATH_OCCUPIED"');
    expect(conflict).not.toContain("throw new Error");
    expect(config).toContain('"CONFIG_PUBLICATION_CONFIRMATION_EXPIRED"');
    expect(config).toContain('"CONFIG_APPLY_CONFIRMATION_EXPIRED"');
    expect(config).toContain('"CONFIG_STAGED_CONTENT_MISMATCH"');
    expect(config).not.toContain("throw new Error");
    expect(main).not.toContain("throw new Error");
  });

  it("attaches precise push stages and copyable redacted reports to operational errors", () => {
    const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
    const publishStart = main.indexOf("private async publishPathV1");
    const publishEnd = main.indexOf("private async pullMissingFilesV1", publishStart);
    const publish = main.slice(publishStart, publishEnd);
    const freezeStart = main.indexOf("private async freezePublishAndReconcileVaultPut");
    const freezeEnd = main.indexOf("private async reconcilePendingPublishedVaultMutations", freezeStart);
    const freeze = main.slice(freezeStart, freezeEnd);
    const errorStart = main.indexOf("private recordOperationalError");
    const errorEnd = main.indexOf("private scheduleV1Retry", errorStart);
    const operationalError = main.slice(errorStart, errorEnd);

    for (const stage of [
      "repository-verification", "outbox-replay", "active-file-validation", "stable-capture",
      "remote-refresh", "outbox-freeze", "local-persistence",
    ]) expect(publish).toContain(`syncStage = "${stage}"`);
    expect(freeze).toContain('let syncStage: SyncFlowStage = "outbox-freeze"');
    for (const stage of ["publication", "publication-verification"]) expect(freeze).toContain(`syncStage = "${stage}"`);
    expect(publish).toContain('withSyncFlowStage("push", syncStage, error)');
    expect(operationalError).toContain("showCopyableNotice(");
    expect(operationalError).toContain("safeSyncErrorReport(error)");
  });
});
