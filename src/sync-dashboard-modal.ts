import { Modal, Setting } from "obsidian";
import type S3SyncPlugin from "./main";
import { mayClaimRepositoryFullyHealthy, repositoryHealthLabel, retryCountdownSeconds } from "../core/operational-status";

export class SyncDashboardModal extends Modal {
  constructor(private readonly plugin: S3SyncPlugin) { super(plugin.app); }

  onOpen(): void { this.render(); }

  private render(): void {
    const status = this.plugin.getOperationalStatus();
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "S3 Sync 状态与诊断" });
    this.contentEl.createEl("p", { text: `阶段：${status.phase}；健康状态：${repositoryHealthLabel(status)}${mayClaimRepositoryFullyHealthy(status) ? "（完整校验通过）" : ""}` });
    const summary = this.contentEl.createDiv({ cls: "s3-sync-status-grid" });
    for (const [label, value] of [
      ["最后成功拉取", formatTime(status.lastSuccessfulPull)],
      ["最后成功发布", formatTime(status.lastSuccessfulPublish)],
      ["最后完整审计", formatTime(status.lastSuccessfulAudit)],
      ["Pending apply", String(status.pendingApply)],
      ["Outbox", String(status.outbox)],
      ["本地并发记录", String(status.localConcurrentRecords)],
      ["恢复文件 / post-capture edit", `${status.recoveryFiles} / ${status.postCaptureEdits}`],
      ["提交缺口", String(status.commitGaps)],
      ["冲突", String(status.conflicts)],
    ]) {
      summary.createDiv({ cls: "s3-sync-status-label", text: label });
      summary.createDiv({ cls: "s3-sync-status-value", text: value });
    }
    if (status.retryAt !== undefined) this.contentEl.createEl("p", { text: `第 ${status.retryAttempt} 次退避，约 ${retryCountdownSeconds(status, Date.now()) ?? 0} 秒后重试。` });
    if (status.lastError) this.contentEl.createEl("p", { cls: "s3-sync-error", text: `${status.lastError.category}：${status.lastError.message}` });

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("立即同步").setCta().onClick(() => void this.run(() => this.plugin.runManualSyncV1())))
      .addButton((button) => button.setButtonText("仅预览").onClick(() => void this.run(() => this.plugin.previewSyncV1())))
      .addButton((button) => button.setButtonText("完整校验").onClick(() => void this.run(() => this.plugin.runFullAuditV1())))
      .addButton((button) => button.setButtonText("查看 Vault 冲突").onClick(() => this.plugin.openConflictModal()));

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("手动重试").onClick(() => void this.run(() => this.plugin.runManualSyncV1())))
      .addButton((button) => button.setButtonText("复制脱敏诊断包").onClick(async () => {
        await navigator.clipboard.writeText(this.plugin.exportRedactedDiagnostics());
        button.setButtonText("已复制");
      }));

    this.contentEl.createEl("h3", { text: "本轮逐路径决策" });
    if (status.decisions.length === 0) this.contentEl.createEl("p", { text: "尚无预览结果。" });
    for (const decision of status.decisions) {
      this.contentEl.createEl("div", { cls: "s3-sync-decision", text: `${decision.decision} · ${decision.path} · ${decision.reason}` });
    }
    this.contentEl.createEl("h3", { text: "完整校验" });
    this.contentEl.createEl("p", { text: `${status.audit.state}：${status.audit.completedObjects}/${status.audit.totalObjects}；缺失闭包 ${status.audit.missingClosure.length}${status.audit.resumable ? "；可续检" : ""}` });
    if (!status.repositoryIdentityValid || status.recoveryRequired) {
      this.contentEl.createEl("p", { cls: "s3-sync-error", text: "仓库身份或恢复状态需要处理；当前仅允许诊断/非破坏性重新接入，不提供清空后重传。" });
    }
  }

  private async run(operation: () => Promise<void>): Promise<void> {
    await operation();
    this.render();
  }
}

function formatTime(value: number | undefined): string { return value === undefined ? "从未" : new Date(value).toLocaleString(); }
