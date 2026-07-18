import { Modal, Notice, Setting, setIcon, type ButtonComponent, type IconName } from "obsidian";
import type S3SyncPlugin from "./main";
import {
  auditCoveragePercent,
  diagnosticCategoryLabel,
  mayClaimRepositoryFullyHealthy,
  operationalPhaseLabel,
  pathDecisionLabel,
  repositoryHealthDisplayLabel,
  repositoryHealthLabel,
  retryCountdownSeconds,
  type OperationalStatus,
} from "../core/operational-status";
import { v1SecurityBoundaryDisclosures } from "../core/security-boundary";
import { logSafeError } from "../core/safe-error";
import { appendCopyableReportButton, showCopyableErrorNotice } from "./copyable-notice";
import { writeClipboardText } from "./clipboard";

export class SyncDashboardModal extends Modal {
  private refreshTimer: number | null = null;
  private operationRunning = false;
  private showDetails = false;

  constructor(private readonly plugin: S3SyncPlugin) { super(plugin.app); }

  onOpen(): void {
    this.setTitle("S3 Sync 状态与检查");
    this.modalEl.addClass("s3-sync-dashboard-modal");
    this.render();
    this.refreshTimer = window.setInterval(() => this.render(), 1_000);
  }

  onClose(): void {
    if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.contentEl.empty();
  }

  private render(): void {
    const status = this.plugin.getOperationalStatus();
    const health = repositoryHealthLabel(status);
    const mutatingAllowed = this.plugin.canAttemptV1Sync();
    const busy = this.operationRunning || this.plugin.isV1OperationRunning();
    this.contentEl.empty();

    const overview = this.contentEl.createDiv({ cls: "s3-sync-dashboard-overview" });
    const phase = overview.createDiv({ cls: "s3-sync-dashboard-phase" });
    phase.createSpan({ cls: "s3-sync-dashboard-phase-label", text: userStatusMessage(!!this.plugin.data.v1, status) });
    if (this.showDetails) {
      phase.createSpan({ cls: `s3-sync-health s3-sync-health-${health}`, text: `${operationalPhaseLabel(status.phase)} · ${repositoryHealthDisplayLabel(status)}` });
      if (mayClaimRepositoryFullyHealthy(status)) phase.createSpan({ cls: "s3-sync-audit-verified", text: "闭包完整" });
    }

    if (!mutatingAllowed) {
      const banner = overview.createDiv({ cls: "s3-sync-diagnostics-banner" });
      const bannerIcon = banner.createSpan({ cls: "s3-sync-inline-icon" });
      setIcon(bannerIcon, "shield-alert");
      banner.createSpan({ text: this.plugin.data.v1
        ? "写操作已暂停；可继续预览、完整校验和复制诊断信息。"
        : "尚未连接仓库。" });
    }

    const summary = this.contentEl.createDiv({ cls: "s3-sync-status-grid" });
    for (const [label, value] of [
      ["最近同步", formatTime(latestSuccessfulSync(status))],
      ["需要处理", userPendingSummary(status)],
    ]) {
      summary.createDiv({ cls: "s3-sync-status-label", text: label });
      summary.createDiv({ cls: "s3-sync-status-value", text: value });
    }

    if (status.retryAt !== undefined) {
      const retry = this.contentEl.createDiv({ cls: "s3-sync-retry-state" });
      const retryIcon = retry.createSpan({ cls: "s3-sync-inline-icon" });
      setIcon(retryIcon, "clock-3");
      retry.createSpan({ text: `第 ${status.retryAttempt} 次退避，${retryCountdownSeconds(status, Date.now()) ?? 0} 秒后重试` });
    }
    if (status.lastError) {
      const error = this.contentEl.createDiv({ cls: "s3-sync-error" });
      error.createEl("strong", { text: `${diagnosticCategoryLabel(status.lastError.category)}：` });
      error.createSpan({ text: status.lastError.message });
      appendCopyableReportButton(error, status.lastError.report);
    }

    if (status.recoveryBlockers.length > 0) {
      const recovery = this.contentEl.createDiv({ cls: "s3-sync-recovery-blockers" });
      for (const blocker of status.recoveryBlockers) {
        recovery.createDiv({
          cls: blocker.disposition === "manual" ? "s3-sync-error" : "s3-sync-retry-state",
          text: `${blocker.disposition === "manual" ? "需要处理" : "自动恢复"}：${blocker.message}`,
        });
      }
    }

    this.renderActions(status, mutatingAllowed, busy);
    new Setting(this.contentEl)
      .setName("诊断与高级功能")
      .setDesc("完整校验、逐文件决策、仓库空间和开发排查信息。")
      .addButton((button) => button
        .setButtonText(this.showDetails ? "收起" : "展开")
        .onClick(() => {
          this.showDetails = !this.showDetails;
          this.render();
        }));
    if (!this.showDetails) return;
    this.renderTechnicalSummary(status);
    this.renderAudit(status);
    this.renderRepositorySpace(status);
    this.renderSecurityBoundary();
    this.renderDecisions(status);
  }

  private renderActions(status: OperationalStatus, mutatingAllowed: boolean, busy: boolean): void {
    const section = this.contentEl.createDiv({ cls: "s3-sync-dashboard-section s3-sync-dashboard-actions" });
    section.createEl("h3", { text: "操作" });
    const primary = new Setting(section).setClass("s3-sync-action-row");
    primary
      .addButton((button) => this.actionButton(button, {
        label: "立即同步",
        icon: "refresh-cw",
        tooltip: "立即执行一轮安全同步",
        disabled: busy || !mutatingAllowed,
        cta: true,
        onClick: () => this.run(() => this.plugin.runManualSyncV1()),
      }));
    if (status.conflicts > 0) primary.addButton((button) => this.actionButton(button, {
        label: "Vault 冲突",
        icon: "git-merge",
        tooltip: "比较并选择需要保留的文件版本",
        disabled: busy,
        onClick: () => this.plugin.openConflictModal(),
      }));
    if (status.retryAt !== undefined || status.lastError !== undefined) {
      primary.addButton((button) => this.actionButton(button, {
        label: "重试",
        icon: "rotate-ccw",
        tooltip: "跳过当前倒计时并立即重试",
        disabled: busy || !mutatingAllowed,
        onClick: () => this.run(() => this.plugin.retryManualSyncV1()),
      }));
    }

    if (!this.showDetails) return;

    const secondary = new Setting(section).setClass("s3-sync-action-row");
    secondary
      .addButton((button) => this.actionButton(button, {
        label: "仅预览",
        icon: "scan-search",
        tooltip: "只计算逐路径决策，不写入本地或远端",
        disabled: busy || !this.plugin.data.v1,
        onClick: () => this.run(() => this.plugin.previewSyncV1(false)),
      }))
      .addButton((button) => this.actionButton(button, {
        label: "完整校验",
        icon: "shield-check",
        tooltip: "验证全部可达的不可变仓库对象",
        disabled: busy || !this.plugin.data.v1,
        onClick: () => this.run(() => this.plugin.runFullAuditV1()),
      }))
      .addButton((button) => this.actionButton(button, {
        label: "同步 Obsidian 设置",
        icon: "sliders-horizontal",
        tooltip: "查看设置快照、逐文件差异和信任确认",
        disabled: busy,
        onClick: () => this.plugin.openConfigCenter(),
      }));
    if (status.audit.state === "running") secondary.addButton((button) => this.actionButton(button, {
        label: "取消校验",
        icon: "circle-stop",
        tooltip: "停止当前完整校验；部分覆盖率不会成为删除依据",
        disabled: false,
        onClick: () => this.plugin.cancelFullAuditV1(),
      }));
    secondary
      .addButton((button) => this.actionButton(button, {
        label: "复制脱敏诊断包",
        icon: "clipboard-copy",
        tooltip: "复制不含凭证、正文和明文路径的诊断数据",
        disabled: busy,
        onClick: () => this.run(async () => {
          await writeClipboardText(this.plugin.exportRedactedDiagnostics());
          new Notice("S3 Sync：已复制脱敏诊断包。");
        }),
      }))
      .addButton((button) => this.actionButton(button, {
        label: "运行环境检查",
        icon: "monitor-check",
        tooltip: "验证桌面文件系统、编辑器事件和重载持久化能力",
        disabled: busy,
        onClick: () => this.run(() => this.plugin.runDesktopRuntimeContract()),
      }));
  }

  private renderTechnicalSummary(status: OperationalStatus): void {
    const summary = this.contentEl.createDiv({ cls: "s3-sync-status-grid" });
    for (const [label, value] of [
      ["最后成功拉取", formatTime(status.lastSuccessfulPull)],
      ["最后成功发布", formatTime(status.lastSuccessfulPublish)],
      ["最后完整校验", formatTime(status.lastSuccessfulAudit)],
      ["待应用", String(status.pendingApply)],
      ["Outbox", String(status.outbox)],
      ["本地并发记录", String(status.localConcurrentRecords)],
      ["恢复文件 / 捕获后编辑", `${status.recoveryFiles} / ${status.postCaptureEdits}`],
      ["提交缺口", String(status.commitGaps)],
      ["Vault 冲突", String(status.conflicts)],
    ]) {
      summary.createDiv({ cls: "s3-sync-status-label", text: label });
      summary.createDiv({ cls: "s3-sync-status-value", text: value });
    }
  }

  private renderAudit(status: OperationalStatus): void {
    const section = this.contentEl.createDiv({ cls: "s3-sync-dashboard-section" });
    section.createEl("h3", { text: "完整校验" });
    const coverage = auditCoveragePercent(status.audit);
    const header = section.createDiv({ cls: "s3-sync-audit-header" });
    header.createSpan({ text: auditStateLabel(status.audit.state) });
    header.createSpan({ text: `${status.audit.completedObjects} / ${status.audit.totalObjects} 对象（${coverage}%）` });
    const progress = section.createEl("progress", { cls: "s3-sync-audit-progress" });
    progress.max = 100;
    progress.value = coverage;

    if (status.audit.resumable && status.audit.state !== "running") {
      section.createDiv({ cls: "s3-sync-audit-resumable", text: "校验已保留部分覆盖率，可从失败状态重新校验。" });
    }
    if (status.audit.missingClosure.length > 0) {
      section.createEl("h4", { text: `缺失闭包（${status.audit.missingClosure.length}）` });
      const list = section.createEl("ul", { cls: "s3-sync-missing-closure" });
      for (const key of status.audit.missingClosure) list.createEl("li").createEl("code", { text: key });
    }
  }

  private renderRepositorySpace(status: OperationalStatus): void {
    const space = status.audit.space;
    if (!space || status.audit.state !== "complete") return;
    const section = this.contentEl.createDiv({ cls: "s3-sync-dashboard-section" });
    section.createEl("h3", { text: "仓库空间" });
    const grid = section.createDiv({ cls: "s3-sync-status-grid" });
    const rows: Array<[string, string]> = [
      ["活跃对象", formatSpaceCategory(space.categories.active)],
      ["冲突对象", formatSpaceCategory(space.categories.conflict)],
      ["历史对象", formatSpaceCategory(space.categories.history)],
      ["孤儿对象（仅报告）", formatSpaceCategory(space.categories.orphan)],
      ["去重节省", formatBytes(space.dedupSavedBytes)],
      ["历史增长", formatBytes(space.historyGrowthBytes)],
    ];
    if (space.requestEstimate) {
      const request = space.requestEstimate;
      rows.push([
        "本次校验请求成本（估算）",
        `${formatCurrency(request.amount, request.currency)} · List ${request.counts.list} / Read ${request.counts.get} / Put ${request.counts.put}`,
      ]);
    }
    for (const [label, value] of rows) {
      grid.createDiv({ cls: "s3-sync-status-label", text: label });
      grid.createDiv({ cls: "s3-sync-status-value", text: value });
    }
  }

  private renderSecurityBoundary(): void {
    const section = this.contentEl.createDiv({ cls: "s3-sync-dashboard-section" });
    section.createEl("h3", { text: "信任与加密边界" });
    const grid = section.createDiv({ cls: "s3-sync-status-grid" });
    for (const disclosure of v1SecurityBoundaryDisclosures) {
      grid.createDiv({ cls: "s3-sync-status-label", text: disclosure.label });
      grid.createDiv({ cls: "s3-sync-status-value", text: disclosure.detail });
    }
  }

  private renderDecisions(status: OperationalStatus): void {
    const section = this.contentEl.createDiv({ cls: "s3-sync-dashboard-section" });
    section.createEl("h3", { text: "本轮逐路径决策" });
    if (status.decisions.length === 0) {
      section.createEl("p", { cls: "s3-sync-empty-state", text: "尚无预览结果。" });
      return;
    }
    const list = section.createDiv({ cls: "s3-sync-decision-list" });
    for (const decision of status.decisions) {
      const item = list.createDiv({ cls: `s3-sync-decision s3-sync-decision-${decision.decision}` });
      item.createSpan({ cls: "s3-sync-decision-kind", text: pathDecisionLabel(decision.decision) });
      item.createEl("code", { cls: "s3-sync-decision-path", text: decision.path });
      item.createSpan({ cls: "s3-sync-decision-reason", text: decision.reason });
    }
  }

  private actionButton(button: ButtonComponent, input: {
    label: string;
    icon: IconName;
    tooltip: string;
    disabled: boolean;
    cta?: boolean;
    onClick: () => void | Promise<void>;
  }): void {
    button
      .setButtonText(input.label)
      .setTooltip(input.tooltip)
      .setDisabled(input.disabled)
      .setClass("s3-sync-action-button")
      .onClick(input.onClick);
    if (input.cta) button.setCta();
    const icon = document.createElement("span");
    icon.className = "s3-sync-button-icon";
    setIcon(icon, input.icon);
    button.buttonEl.prepend(icon);
  }

  private async run(operation: () => Promise<void>): Promise<void> {
    if (this.operationRunning) return;
    this.operationRunning = true;
    this.render();
    try {
      await operation();
    } catch (error) {
      showCopyableErrorNotice("S3 Sync：状态页操作失败", error, "dashboard-operation");
      logSafeError("S3 Sync dashboard operation failed", error);
    } finally {
      this.operationRunning = false;
      this.render();
    }
  }
}

function formatTime(value: number | undefined): string {
  return value === undefined ? "从未" : new Date(value).toLocaleString();
}

function latestSuccessfulSync(status: OperationalStatus): number | undefined {
  const values = [status.lastSuccessfulPull, status.lastSuccessfulPublish]
    .filter((value): value is number => value !== undefined);
  return values.length > 0 ? Math.max(...values) : undefined;
}

function userStatusMessage(connected: boolean, status: OperationalStatus): string {
  if (!connected) return "尚未连接 S3 仓库";
  if (!["idle", "read-only", "waiting-retry", "stopped"].includes(status.phase)) {
    return `正在${operationalPhaseLabel(status.phase)}`;
  }
  if (status.conflicts > 0) return `有 ${status.conflicts} 个文件冲突需要选择版本`;
  if (status.recoveryBlockers.some((blocker) => blocker.disposition === "manual")) return "需要完成本地恢复后才能继续同步";
  if (status.lastError) return "上次同步没有完成，请查看错误并重试";
  if (status.outbox > 0 || status.pendingApply > 0 || status.localConcurrentRecords > 0
    || status.recoveryFiles > 0 || status.commitGaps > 0) return "有同步内容正在等待处理";
  if (latestSuccessfulSync(status) === undefined) return "已连接，尚未完成首次同步";
  return "同步状态正常";
}

function userPendingSummary(status: OperationalStatus): string {
  const parts: string[] = [];
  if (status.conflicts > 0) parts.push(`${status.conflicts} 个冲突`);
  const waiting = status.pendingApply + status.localConcurrentRecords;
  if (waiting > 0) parts.push(`${waiting} 项等待处理`);
  if (status.outbox > 0) parts.push(`${status.outbox} 项等待上传`);
  const recovery = status.recoveryBlockers.length + status.recoveryFiles + status.commitGaps;
  if (recovery > 0) parts.push(`${recovery} 项等待恢复或验证`);
  return parts.length > 0 ? parts.join("，") : "无";
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let amount = value / 1_024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1_024; index += 1) {
    amount /= 1_024;
    unit = units[index];
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${unit}`;
}

function formatSpaceCategory(category: { objects: number; bytes: number }): string {
  return `${formatBytes(category.bytes)} · ${category.objects} 个`;
}

function formatCurrency(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: 6, maximumFractionDigits: 6 })}`;
}

function auditStateLabel(state: OperationalStatus["audit"]["state"]): string {
  const labels: Record<OperationalStatus["audit"]["state"], string> = {
    never: "尚未校验",
    running: "校验中",
    complete: "校验完成",
    cancelled: "校验已中断",
    failed: "校验失败",
  };
  return labels[state];
}
