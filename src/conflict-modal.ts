import { Modal, Notice, Setting, type App } from "obsidian";
import { hashPrivateValue } from "../core/diagnostic-bundle";
import { logSafeError, safeErrorMessage } from "../core/safe-error";
import type S3SyncPlugin from "./main";
import type { LocalCopyCleanupSummary } from "./main";
import { showCopyableErrorNotice } from "./copyable-notice";
import { writeClipboardText } from "./clipboard";
import type { ConflictRecord } from "./types";
import type { RemoteVaultConflictCandidate } from "../core/remote-vault-conflict";
import { groupRemoteConflictCandidates, type RemoteCandidateGroup } from "./conflict-presentation";
import type { ConflictPreviewSide, ConflictTextComparison } from "./conflict-preview";

type ComparisonState =
  | { candidateVersionId: string; status: "loading" }
  | { candidateVersionId: string; status: "ready"; comparison: ConflictTextComparison }
  | { candidateVersionId: string; status: "error"; message: string };

export class ConflictModal extends Modal {
  private readonly plugin: S3SyncPlugin;
  private readonly expandedTechnical = new Set<string>();
  private readonly comparisons = new Map<string, ComparisonState>();
  private readonly selectedRemoteVersions = new Map<string, string>();
  private cleanupSummary: LocalCopyCleanupSummary | undefined;
  private cleanupSummaryLoading = false;
  private cleanupSummaryError: string | undefined;
  private cleanupRunning = false;
  private opened = false;

  constructor(plugin: S3SyncPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.opened = true;
    this.modalEl.addClass("s3-sync-conflict-modal");
    this.plugin.recordConflictModalOpened();
    this.render();
  }

  onClose(): void {
    this.opened = false;
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "S3 Sync 冲突" });
    contentEl.createEl("p", {
      cls: "s3-sync-conflict-intro",
      text: "本地与远端对同一文件产生了不同结果。每个文件选择一个最终版本；只有远端确实存在多个不同内容时，才需要额外选择远端候选。",
    });

    const conflicts = Object.values(this.plugin.data.conflicts)
      .filter((conflict) => !conflict.resolved)
      .sort((left, right) => left.path.localeCompare(right.path));
    if (conflicts.length === 0) {
      contentEl.createEl("p", { text: "当前没有未解决冲突。" });
    } else {
      const list = contentEl.createDiv({ cls: "s3-sync-conflict-list" });
      for (const conflict of conflicts) {
        this.renderConflictRow(list, conflict);
      }
    }
    this.renderCleanupAction(contentEl);
  }

  private renderConflictRow(container: HTMLElement, conflict: ConflictRecord): void {
    const item = container.createDiv({ cls: "s3-sync-conflict-item" });
    const groups = groupRemoteConflictCandidates(conflict.remoteCandidates);
    const candidate = this.selectedRemoteCandidate(conflict, groups);
    const comparisonState = this.comparisons.get(conflict.id);
    const activeComparison = candidate && comparisonState?.candidateVersionId === candidate.versionId
      ? comparisonState
      : undefined;
    const row = new Setting(item)
      .setClass("s3-sync-conflict-summary-row")
      .setName(conflict.path)
      .setDesc(conflictRowDescription(conflict, groups));
    row.addButton((button) => button
      .setButtonText(activeComparison?.status === "loading"
        ? "加载中…"
        : activeComparison?.status === "ready" ? "收起对照" : "左右对照")
      .setTooltip(candidate ? "并排查看本地文件与当前选中的远端版本" : "当前没有可比较的远端版本")
      .setDisabled(!candidate || activeComparison?.status === "loading")
      .onClick(() => candidate && this.toggleComparison(conflict, candidate)));
    row.addButton((button) => button
      .setButtonText("使用本地版本")
      .setTooltip(conflict.localHash === null ? "保留这台设备上的删除结果" : "保留当前 Vault 文件并同步到远端")
      .onClick(() => this.keepLocal(conflict)));
    row.addButton((button) => button
      .setButtonText("使用远端版本")
      .setTooltip(candidate?.kind === "delete" ? "采用远端删除结果" : "采用当前选中的远端文件")
      .setDisabled(!candidate)
      .onClick(() => candidate && this.useRemote(conflict, candidate)));

    if (groups.length > 1) this.renderRemoteChooser(item, conflict, groups, candidate);
    if (activeComparison) this.renderComparison(item, activeComparison);
    this.renderTechnicalDetails(item, conflict, candidate);
  }

  private selectedRemoteCandidate(
    conflict: ConflictRecord,
    groups: readonly RemoteCandidateGroup[],
  ): RemoteVaultConflictCandidate | undefined {
    const selected = this.selectedRemoteVersions.get(conflict.id);
    return groups.find((group) => group.candidate.versionId === selected)?.candidate ?? groups[0]?.candidate;
  }

  private renderRemoteChooser(
    container: HTMLElement,
    conflict: ConflictRecord,
    groups: readonly RemoteCandidateGroup[],
    selected: RemoteVaultConflictCandidate | undefined,
  ): void {
    new Setting(container)
      .setClass("s3-sync-conflict-remote-chooser")
      .setName(`远端有 ${groups.length} 个不同版本`)
      .setDesc("先选择要比较或采用的远端版本；内容相同的并发版本已自动合并显示。")
      .addDropdown((dropdown) => {
        groups.forEach((group, index) => dropdown.addOption(
          group.candidate.versionId,
          remoteCandidateLabel(group, index),
        ));
        if (selected) dropdown.setValue(selected.versionId);
        dropdown.onChange((versionId) => {
          this.selectedRemoteVersions.set(conflict.id, versionId);
          this.comparisons.delete(conflict.id);
          this.render();
        });
      });
  }

  private async toggleComparison(
    conflict: ConflictRecord,
    candidate: RemoteVaultConflictCandidate,
  ): Promise<void> {
    const current = this.comparisons.get(conflict.id);
    if (current?.candidateVersionId === candidate.versionId && current.status === "ready") {
      this.comparisons.delete(conflict.id);
      this.render();
      return;
    }
    this.comparisons.set(conflict.id, { candidateVersionId: candidate.versionId, status: "loading" });
    this.render();
    try {
      const comparison = await this.plugin.loadConflictTextComparison(conflict.id, candidate.versionId);
      this.comparisons.set(conflict.id, { candidateVersionId: candidate.versionId, status: "ready", comparison });
    } catch (error) {
      this.comparisons.set(conflict.id, {
        candidateVersionId: candidate.versionId,
        status: "error",
        message: safeErrorMessage(error),
      });
      showCopyableErrorNotice("S3 Sync：加载冲突左右对照失败", error, "conflict-compare");
      logSafeError("S3 Sync conflict comparison failed", error);
    }
    this.render();
  }

  private renderComparison(container: HTMLElement, state: ComparisonState): void {
    const comparison = container.createDiv({ cls: "s3-sync-conflict-comparison" });
    if (state.status === "loading") {
      comparison.createDiv({ cls: "s3-sync-conflict-preview-state", text: "正在安全读取本地文件并下载远端候选…" });
      return;
    }
    if (state.status === "error") {
      comparison.createDiv({ cls: "s3-sync-conflict-preview-state s3-sync-conflict-preview-error", text: state.message });
      return;
    }
    comparison.createDiv({
      cls: "s3-sync-conflict-preview-note",
      text: "当前为整文件左右对照，不标注行级增删；请选择整个本地版本或整个远端版本。",
    });
    const grid = comparison.createDiv({ cls: "s3-sync-conflict-preview-grid" });
    this.renderPreviewSide(grid, "这台设备", state.comparison.local);
    this.renderPreviewSide(grid, "远端候选", state.comparison.remote);
  }

  private renderPreviewSide(container: HTMLElement, title: string, side: ConflictPreviewSide): void {
    const column = container.createDiv({ cls: "s3-sync-conflict-preview-side" });
    column.createEl("h4", { text: title });
    if (side.kind === "missing") {
      column.createDiv({ cls: "s3-sync-conflict-preview-state", text: "文件不存在或该版本表示删除。" });
      return;
    }
    if (side.kind === "unavailable") {
      column.createDiv({
        cls: "s3-sync-conflict-preview-state",
        text: `${conflictPreviewUnavailableMessage(side.reason)} · ${formatBytes(side.size)}${side.lines === undefined ? "" : ` · ${side.lines} 行`}`,
      });
      return;
    }
    column.createDiv({
      cls: "s3-sync-conflict-preview-meta",
      text: `${formatBytes(side.size)} · ${side.lines} 行`,
    });
    const preview = column.createEl("pre", { cls: "s3-sync-conflict-preview-text" });
    preview.createEl("code", { text: side.text });
  }

  private renderTechnicalDetails(
    container: HTMLElement,
    conflict: ConflictRecord,
    candidate?: RemoteVaultConflictCandidate,
  ): void {
    const expanded = this.expandedTechnical.has(conflict.id);
    new Setting(container)
      .setName("技术详情与诊断")
      .setDesc("Hash、远端头和供开发排查的脱敏信息。")
      .addButton((button) => button
        .setButtonText(expanded ? "收起" : "展开")
        .onClick(() => {
          if (expanded) this.expandedTechnical.delete(conflict.id);
          else this.expandedTechnical.add(conflict.id);
          this.render();
        }));
    if (!expanded) return;
    const meta = container.createDiv({ cls: "s3-sync-conflict-meta" });
    this.addMeta(meta, "基础 Hash", conflict.baseHash ?? "无");
    this.addMeta(meta, "本地 Hash", conflict.localHash ?? "已删除");
    this.addMeta(meta, "远端状态", conflict.remoteDisposition === "concurrent" ? "并发" : "已解析");
    this.addMeta(meta, "远端候选", String(conflict.remoteCandidates.length));
    this.addMeta(meta, "远端头", String(conflict.remoteHeads.length));
    this.addMeta(meta, "发现时间", conflict.detectedAt);
    const actions = new Setting(container)
      .setClass("s3-sync-conflict-technical-actions")
      .setName("恢复与诊断")
      .setDesc("这些入口只用于核对副本，不会替你选择版本。");
    if (conflict.localHash !== null) actions.addButton((button) => button
      .setButtonText("打开本地文件")
      .setTooltip("打开当前 Vault 中的本地文件")
      .onClick(() => this.runAction(
        "打开本地文件失败",
        "conflict-open-local",
        () => this.plugin.openFile(conflict.path),
      )));
    const recoveryId = this.latestRecoveryId(conflict);
    if (recoveryId) actions.addButton((button) => button
      .setButtonText("打开原本机副本")
      .setTooltip("校验后打开冲突应用前保留的本机内容")
      .onClick(() => this.runAction(
        "打开原本机副本失败",
        "conflict-open-recovery",
        () => this.plugin.openConflictRecoveryCopy(conflict.id, recoveryId),
      )));
    if (candidate?.kind === "put") actions.addButton((button) => button
      .setButtonText("打开所选远端副本")
      .setTooltip("下载、校验并打开当前选择的远端候选副本")
      .onClick(() => this.runAction(
        "打开远端副本失败",
        "conflict-open-remote",
        () => this.plugin.openConflictCandidateCopy(conflict.id, candidate.versionId),
      )));
    actions.addButton((button) => button
      .setButtonText("复制诊断信息")
      .setTooltip("复制不含明文路径和凭证的冲突信息")
      .onClick(() => this.copyDiagnostics(conflict)));
  }

  private latestRecoveryId(conflict: ConflictRecord): string | undefined {
    const record = Object.values(this.plugin.data.v1RecoveryRecords)
      .filter((candidate) => candidate.logicalPath === conflict.path
        && candidate.source === "apply-before-image"
        && candidate.cleanupState !== "cleaned")
      .sort((left, right) => right.capturedAt - left.capturedAt)[0];
    if (record) return record.id;
    return [...this.plugin.data.v1ApplyJournals]
      .reverse()
      .find((journal) => journal.path === conflict.path && journal.expectedLocal.kind === "present")
      ?.operationId;
  }

  private renderCleanupAction(container: HTMLElement): void {
    if (!this.plugin.data.v1) return;
    const setting = new Setting(container)
      .setClass("s3-sync-conflict-cleanup")
      .setName("本地安全副本")
      .setDesc(this.cleanupDescription());
    if (this.cleanupSummaryError) {
      setting.addButton((button) => button
        .setButtonText("重新检查")
        .setTooltip("重新检查可安全清理的本地副本")
        .onClick(() => {
          this.cleanupSummaryError = undefined;
          void this.refreshCleanupSummary();
        }));
      return;
    }
    const cleanable = (this.cleanupSummary?.recoveryFiles ?? 0) + (this.cleanupSummary?.conflictFolders ?? 0);
    setting.addButton((button) => button
      .setButtonText(this.cleanupRunning
        ? "正在清理…"
        : this.cleanupSummaryLoading || !this.cleanupSummary
          ? "正在检查…"
          : cleanable > 0 ? "清理已解决副本" : "没有可清理项")
      .setTooltip("只清理已解决且不再被恢复流程引用的本地副本；不影响当前 Vault 文件和 S3 数据")
      .setDisabled(this.cleanupRunning || this.cleanupSummaryLoading || cleanable === 0)
      .onClick(() => this.confirmAndCleanup()));
    if (!this.cleanupSummary && !this.cleanupSummaryLoading) void this.refreshCleanupSummary();
  }

  private cleanupDescription(): string {
    if (this.cleanupSummaryError) return `检查失败：${this.cleanupSummaryError}`;
    if (!this.cleanupSummary || this.cleanupSummaryLoading) return "正在检查已解决且可安全删除的本地副本…";
    const cleanable = [
      `${this.cleanupSummary.recoveryFiles} 个恢复文件（${formatBytes(this.cleanupSummary.recoveryBytes)}）`,
      `${this.cleanupSummary.conflictFolders} 个已解决冲突目录`,
    ].join("、");
    const protectedText = this.cleanupSummary.protectedFiles > 0
      ? `；另有 ${this.cleanupSummary.protectedFiles} 个副本仍用于恢复或已被修改，将继续保留`
      : "";
    return `可清理 ${cleanable}${protectedText}。管理目录 .obsidian-s3-sync-local 会继续保留。`;
  }

  private async refreshCleanupSummary(): Promise<void> {
    if (this.cleanupSummaryLoading) return;
    this.cleanupSummaryLoading = true;
    this.render();
    try {
      this.cleanupSummary = await this.plugin.getLocalCopyCleanupSummary();
      this.cleanupSummaryError = undefined;
    } catch (error) {
      this.cleanupSummary = undefined;
      this.cleanupSummaryError = safeErrorMessage(error);
      logSafeError("S3 Sync local copy cleanup inspection failed", error);
    } finally {
      this.cleanupSummaryLoading = false;
      if (this.opened) this.render();
    }
  }

  private async confirmAndCleanup(): Promise<void> {
    const summary = this.cleanupSummary;
    if (!summary || !(await confirmLocalCopyCleanup(this.app, summary))) return;
    this.cleanupRunning = true;
    this.render();
    try {
      const result = await this.plugin.cleanupResolvedLocalCopies();
      const preserved = result.modifiedFilesPreserved > 0
        ? `；${result.modifiedFilesPreserved} 个已变化副本为安全起见继续保留`
        : "";
      new Notice(`已清理 ${result.recoveryFiles} 个恢复记录和 ${result.conflictFolders} 个冲突目录，释放约 ${formatBytes(result.recoveryBytes)}${preserved}`);
      this.cleanupSummary = undefined;
      this.cleanupSummaryError = undefined;
    } catch (error) {
      showCopyableErrorNotice("S3 Sync：清理本地安全副本失败", error, "local-copy-cleanup");
      logSafeError("S3 Sync local copy cleanup failed", error);
    } finally {
      this.cleanupRunning = false;
      if (this.opened) this.render();
    }
  }

  private async keepLocal(conflict: ConflictRecord): Promise<void> {
    if (conflict.localHash === null && !(await confirmDeleteResolution(this.app, conflict.path))) return;
    try {
      await this.plugin.resolveConflict(conflict.id, "local");
      this.comparisons.delete(conflict.id);
      this.cleanupSummary = undefined;
      new Notice(conflict.localHash === null
        ? "已保留本机删除结果；其他候选副本仍保留。"
        : "已保留本机作为主文件；其他候选副本仍保留。 ");
      this.render();
    } catch (error) {
      showCopyableErrorNotice("S3 Sync：解决本地冲突失败", error, "conflict-local");
      logSafeError("S3 Sync local conflict resolution failed", error);
    }
  }

  private async useRemote(conflict: ConflictRecord, candidate: RemoteVaultConflictCandidate): Promise<void> {
    if (candidate.kind === "delete" && !(await confirmDeleteResolution(this.app, conflict.path))) return;
    try {
      await this.plugin.resolveConflict(conflict.id, "remote", candidate.versionId);
      this.comparisons.delete(conflict.id);
      this.cleanupSummary = undefined;
      new Notice(candidate.kind === "delete"
        ? "已采用删除结果；本机原内容由恢复机制保留。"
        : "已使用所选远端版本；本机原内容由恢复机制保留。");
      this.render();
    } catch (error) {
      showCopyableErrorNotice("S3 Sync：解决远端冲突失败", error, "conflict-remote");
      logSafeError("S3 Sync remote candidate resolution failed", error);
      this.render();
    }
  }

  private async copyDiagnostics(conflict: ConflictRecord): Promise<void> {
    await this.runAction("复制冲突诊断失败", "conflict-copy", async () => {
      await writeClipboardText([
        `pathHash=${hashPrivateValue(conflict.path, this.plugin.data.v1?.repositoryId ?? this.plugin.manifest.id)}`,
        `baseHash=${conflict.baseHash ?? "null"}`,
        `localHash=${conflict.localHash ?? "null"}`,
        `remoteDisposition=${conflict.remoteDisposition}`,
        `remoteHeadCount=${conflict.remoteHeads.length}`,
        `remoteCandidateCount=${conflict.remoteCandidates.length}`,
        ...conflict.remoteCandidates.map((candidate, index) => candidate.kind === "put"
          ? `remoteCandidate${index + 1}=put:${candidate.hash}:${candidate.size}`
          : `remoteCandidate${index + 1}=delete`),
        `detectedAt=${conflict.detectedAt}`,
      ].join("\n"));
      new Notice("已复制冲突诊断信息");
    });
  }

  private addMeta(container: HTMLElement, label: string, value: string): void {
    container.createDiv({ cls: "s3-sync-conflict-label", text: label });
    container.createDiv({ cls: "s3-sync-conflict-value", text: value });
  }

  private async runAction(label: string, context: string, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      showCopyableErrorNotice(`S3 Sync：${label}`, error, context);
      logSafeError(`S3 Sync ${context}`, error);
    }
  }
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function conflictPreviewUnavailableMessage(reason: Extract<ConflictPreviewSide, { kind: "unavailable" }>["reason"]): string {
  return {
    binary: "检测为非文本文件，无法显示文本对照",
    "invalid-utf8": "文件不是有效 UTF-8 文本，无法显示文本对照",
    "too-large": "文件超过 1 MiB 预览上限",
    "too-many-lines": "文件超过 20,000 行预览上限",
  }[reason];
}

function conflictRowDescription(
  conflict: ConflictRecord,
  groups: readonly RemoteCandidateGroup[],
): string {
  if (groups.length > 1) return `远端有 ${groups.length} 个不同内容；先选一个远端版本，再进行对照或采用。`;
  if (groups[0]?.candidate.kind === "delete") return "远端版本表示删除；请选择保留本地结果还是采用远端删除。";
  return conflict.remoteDisposition === "concurrent"
    ? "检测到并发远端头，但其内容相同；请选择保留本地还是采用远端。"
    : "本地与远端都偏离共同基线；请选择整个文件的最终版本。";
}

function remoteCandidateLabel(group: RemoteCandidateGroup, index: number): string {
  const detail = group.candidate.kind === "delete" ? "删除" : formatBytes(group.candidate.size);
  const duplicateHeads = group.count > 1 ? ` · ${group.count} 个同内容头` : "";
  return `远端版本 ${index + 1} · ${detail}${duplicateHeads}`;
}

class LocalCopyCleanupConfirmationModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly summary: LocalCopyCleanupSummary,
    private readonly resolveResult: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("确认清理已解决副本");
    this.contentEl.createEl("p", {
      text: `将清理 ${this.summary.recoveryFiles} 个恢复文件（约 ${formatBytes(this.summary.recoveryBytes)}）和 ${this.summary.conflictFolders} 个已解决冲突目录。`,
    });
    this.contentEl.createDiv({
      cls: "s3-sync-config-warning",
      text: "不会删除当前 Vault 文件，不会删除 S3 对象或历史，也不会删除 .obsidian-s3-sync-local 管理目录。仍被冲突、应用日志或人工修改引用的副本会继续保留。",
    });
    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText("取消")
        .onClick(() => this.finish(false)))
      .addButton((button) => button
        .setButtonText("确认清理本地副本")
        .setDestructive()
        .setCta()
        .onClick(() => this.finish(true)));
  }

  onClose(): void {
    if (!this.settled) this.resolveResult(false);
  }

  private finish(confirmed: boolean): void {
    this.settled = true;
    this.resolveResult(confirmed);
    this.close();
  }
}

class DeleteConflictConfirmationModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly path: string,
    private readonly resolveResult: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("确认采用删除结果");
    this.contentEl.createEl("p", { text: this.path });
    this.contentEl.createDiv({
      cls: "s3-sync-config-warning",
      text: "主文件将被删除并发布为冲突解决结果。本机原内容和远端候选仍会由恢复与历史机制保留。",
    });
    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText("取消")
        .onClick(() => this.finish(false)))
      .addButton((button) => button
        .setButtonText("确认删除主文件")
        .setDestructive()
        .setCta()
        .onClick(() => this.finish(true)));
  }

  onClose(): void {
    if (!this.settled) this.resolveResult(false);
  }

  private finish(confirmed: boolean): void {
    this.settled = true;
    this.resolveResult(confirmed);
    this.close();
  }
}

function confirmDeleteResolution(app: App, path: string): Promise<boolean> {
  return new Promise((resolve) => new DeleteConflictConfirmationModal(app, path, resolve).open());
}

function confirmLocalCopyCleanup(app: App, summary: LocalCopyCleanupSummary): Promise<boolean> {
  return new Promise((resolve) => new LocalCopyCleanupConfirmationModal(app, summary, resolve).open());
}
