import { Modal, Notice, Setting, type App } from "obsidian";
import { hashPrivateValue } from "../core/diagnostic-bundle";
import { logSafeError } from "../core/safe-error";
import type S3SyncPlugin from "./main";
import { showCopyableErrorNotice } from "./copyable-notice";
import { writeClipboardText } from "./clipboard";
import type { ConflictRecord } from "./types";
import type { RemoteVaultConflictCandidate } from "../core/remote-vault-conflict";
import { groupRemoteConflictCandidates, type RemoteCandidateGroup } from "./conflict-presentation";

export class ConflictModal extends Modal {
  private readonly plugin: S3SyncPlugin;
  private readonly expandedTechnical = new Set<string>();

  constructor(plugin: S3SyncPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.plugin.recordConflictModalOpened();
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "S3 Sync 冲突" });
    contentEl.createEl("p", {
      cls: "s3-sync-conflict-intro",
      text: "同一文件在多台设备上发生了不同修改。请先打开版本比较，再选择主文件；其他候选副本不会立即删除。",
    });

    const conflicts = Object.values(this.plugin.data.conflicts).filter((conflict) => !conflict.resolved);
    if (conflicts.length === 0) {
      contentEl.createEl("p", { text: "当前没有未解决冲突。" });
      return;
    }

    const list = contentEl.createDiv({ cls: "s3-sync-conflict-list" });
    for (const conflict of conflicts) {
      const item = list.createDiv({ cls: "s3-sync-conflict-item" });
      item.createEl("strong", { text: conflict.path });
      item.createDiv({
        cls: "s3-sync-conflict-guidance",
        text: "选择后会生成一个新的同步结果；未选择的远端内容仍保留在候选副本中。",
      });

      this.renderLocalVersion(item, conflict);
      for (const [index, group] of groupRemoteConflictCandidates(conflict.remoteCandidates).entries()) {
        this.renderRemoteVersion(item, conflict, group, index);
      }
      this.renderTechnicalDetails(item, conflict);
    }
  }

  private renderLocalVersion(container: HTMLElement, conflict: ConflictRecord): void {
    const local = new Setting(container)
      .setName("这台设备的版本")
      .setDesc(conflict.localHash === null
        ? conflict.baseHash === null
          ? "这台设备当前没有该文件，也没有可确认的本机修改。"
          : "这台设备已删除该文件；可以保留删除结果，云端内容仍会保留为候选副本。"
        : "当前 Vault 中的文件；选择后会作为主文件发布，远端候选副本继续保留。");
    if (conflict.localHash === null) {
      if (conflict.baseHash !== null) local.addButton((button) => button
        .setButtonText("保留本机删除结果")
        .onClick(() => this.keepLocal(conflict)));
      return;
    }
    local
      .addButton((button) => button
        .setButtonText("打开查看")
        .setIcon("file")
        .onClick(() => this.runAction(
          "打开本地文件失败",
          "conflict-open-local",
          () => this.plugin.openFile(conflict.path),
        )))
      .addButton((button) => button
        .setButtonText("保留本机作为主文件")
        .onClick(() => this.keepLocal(conflict)));
  }

  private renderRemoteVersion(
    container: HTMLElement,
    conflict: ConflictRecord,
    group: RemoteCandidateGroup,
    index: number,
  ): void {
    const candidate = group.candidate;
    const setting = new Setting(container)
      .setName(`其他设备的版本 ${index + 1}`)
      .setDesc(candidate.kind === "delete"
        ? `${group.count > 1 ? `${group.count} 个相同远端版本均` : "远端版本"}表示删除该文件。`
        : `${formatBytes(candidate.size)}${group.count > 1 ? ` · ${group.count} 个远端版本内容相同` : ""}；选择后本机原内容会保留在恢复区。`);
    if (candidate.kind === "put") {
      setting.addButton((button) => button
        .setButtonText("打开查看")
        .setIcon("file-search")
        .onClick(() => this.runAction(
          "打开冲突候选副本失败",
          "conflict-open-candidate",
          () => this.plugin.openConflictCandidateCopy(conflict.id, candidate.versionId),
        )));
    }
    setting.addButton((button) => button
      .setButtonText(candidate.kind === "delete" ? "选择删除结果" : "使用这个版本")
      .onClick(() => this.useRemote(conflict, candidate)));
  }

  private renderTechnicalDetails(container: HTMLElement, conflict: ConflictRecord): void {
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
    new Setting(container).addButton((button) => button
      .setButtonText("复制诊断信息")
      .setIcon("copy")
      .onClick(() => this.copyDiagnostics(conflict)));
  }

  private async keepLocal(conflict: ConflictRecord): Promise<void> {
    if (conflict.localHash === null && !(await confirmDeleteResolution(this.app, conflict.path))) return;
    try {
      await this.plugin.resolveConflict(conflict.id, "local");
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
      new Notice(candidate.kind === "delete"
        ? "已采用删除结果；本机原内容由恢复机制保留。"
        : "已使用所选远端版本；本机原内容由恢复机制保留。");
      this.render();
    } catch (error) {
      showCopyableErrorNotice("S3 Sync：解决远端冲突失败", error, "conflict-remote");
      logSafeError("S3 Sync remote candidate resolution failed", error);
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
