import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("v1 plugin entrypoint contract", () => {
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
    expect(settings.match(/\.setName\("配置中心"\)/g) ?? []).toHaveLength(1);
    expect(settings).not.toContain("configSyncEnabled");
    expect(copyableNotice).toContain('setIcon(button, "copy")');
    expect(copyableNotice).toContain("safeGenericErrorReport(error, context)");
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

  it("pulls before publishing every pending path and stops on conflicts or pending decisions", () => {
    const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
    const start = main.indexOf("private async runV1SyncRound");
    const end = main.indexOf("private async buildV1PathDecisions", start);
    const syncRound = main.slice(start, end);
    const pullIndex = syncRound.indexOf("await this.pullMissingFilesV1(false)");
    const blockedIndex = syncRound.indexOf('if (pull.status === "blocked")');
    const pushIndex = syncRound.indexOf("await this.publishPendingPathsV1()");

    expect(pullIndex).toBeGreaterThanOrEqual(0);
    expect(blockedIndex).toBeGreaterThan(pullIndex);
    expect(pushIndex).toBeGreaterThan(blockedIndex);
    expect(syncRound.slice(blockedIndex, pushIndex)).toContain("return;");

    const publishStart = main.indexOf("private async publishPendingPathsV1");
    const publishEnd = main.indexOf("private async publishPathV1", publishStart);
    const publishPending = main.slice(publishStart, publishEnd);
    expect(publishPending).toContain("for (const path of orderedPaths)");
    expect(publishPending).toContain("await this.publishPathV1(path)");

    const pullStart = main.indexOf("private async pullMissingFilesV1");
    const pullEnd = main.indexOf("async runDesktopRuntimeContract", pullStart);
    const pull = main.slice(pullStart, pullEnd);
    expect(pull).toContain("return this.finishV1Pull(");
    expect(pull).toContain("new ConflictModal(this).open()");
    expect(pull).toContain("new SyncDashboardModal(this).open()");
    expect(pull).toContain('? { status: "blocked", conflicts: blocked.conflicts, pending: blocked.pending }');
    expect(main).toContain('"REMOTE_STRUCTURAL_PATH_CONFLICT"');
    expect(main.indexOf("findStructuralConflicts(occupiedPaths)")).toBeLessThan(
      main.indexOf("materializeV1ConflictCandidates(state, service, pulled, decisions)"),
    );
  });

  it("revalidates stale repository identity locks before reading remote conflict candidates", () => {
    const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
    const dashboard = readFileSync(new URL("../../src/sync-dashboard-modal.ts", import.meta.url), "utf8");
    const pullStart = main.indexOf("private async pullMissingFilesV1");
    const pullEnd = main.indexOf("async runDesktopRuntimeContract", pullStart);
    const pull = main.slice(pullStart, pullEnd);
    const verification = pull.indexOf("await this.assertV1RepositoryBinding(state)");
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

  it("recovers every unfinished Outbox and verifies conflict candidate copies before opening them", () => {
    const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
    const modal = readFileSync(new URL("../../src/conflict-modal.ts", import.meta.url), "utf8");
    const drainStart = main.indexOf("private async drainDurableOutboxIfPresent");
    const drainEnd = main.indexOf("private async freezePublishAndReconcileVaultPut", drainStart);
    const drain = main.slice(drainStart, drainEnd);

    expect(drain).toContain('some((entry) => entry.state !== "published")');
    expect(main).toContain('"DURABLE_OUTBOX_WRITER_MISMATCH"');
    expect(main).toContain("input.service.inspectRepositoryState(");
    expect(main).toContain("conflictCopyContentMatches(bytes, expected)");
    expect(main).toContain("await this.materializeConflictCopies(state, service, id, path, remote.candidates)");
    expect(main).toContain("conflictId(state.repositoryId, \"vault\", [remote.path], remote.heads)");
    expect(main).toContain("conflictVersionCopyPath(id, versionId, remote.path)");
    expect(modal).toContain("candidate.versionId, conflict.path");
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
