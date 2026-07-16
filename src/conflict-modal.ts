import { Modal, Notice, Setting } from "obsidian";
import { hashPrivateValue } from "../core/diagnostic-bundle";
import { conflictVersionCopyPath } from "../core/conflict-copy";
import { logSafeError } from "../core/safe-error";
import type S3SyncPlugin from "./main";
import { showCopyableErrorNotice } from "./copyable-notice";
import { writeClipboardText } from "./clipboard";

export class ConflictModal extends Modal {
  private readonly plugin: S3SyncPlugin;

  constructor(plugin: S3SyncPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "S3 Sync 冲突" });

    const conflicts = Object.values(this.plugin.data.conflicts).filter((conflict) => !conflict.resolved);
    if (conflicts.length === 0) {
      contentEl.createEl("p", { text: "当前没有未解决冲突。" });
      return;
    }

    const list = contentEl.createDiv({ cls: "s3-sync-conflict-list" });
    for (const conflict of conflicts) {
      const item = list.createDiv({ cls: "s3-sync-conflict-item" });
      item.createEl("strong", { text: conflict.path });

      const meta = item.createDiv({ cls: "s3-sync-conflict-meta" });
      this.addMeta(meta, "基础 Hash", conflict.baseHash ?? "无");
      this.addMeta(meta, "本地 Hash", conflict.localHash ?? "已删除");
      this.addMeta(meta, "远端状态", conflict.remoteDisposition === "concurrent" ? "并发" : "已解析");
      this.addMeta(meta, "远端候选", String(conflict.remoteCandidates.length));
      this.addMeta(meta, "远端头", String(conflict.remoteHeads.length));
      this.addMeta(meta, "发现时间", conflict.detectedAt);

      const actions = new Setting(item)
        .addButton((button) => button
          .setButtonText("复制诊断信息")
          .setIcon("copy")
          .onClick(async () => {
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
          }))
        .addButton((button) => button
          .setButtonText("打开本地文件")
          .setIcon("file")
          .onClick(async () => {
            await this.runAction("打开本地文件失败", "conflict-open-local", () => this.plugin.openFile(conflict.path));
          }))
        .addButton((button) => button
          .setButtonText("使用本地")
          .setDisabled(conflict.localHash === null)
          .setCta()
          .onClick(async () => {
            try {
              await this.plugin.resolveConflict(conflict.id, "local");
              new Notice("已使用本地版本");
              this.render();
            } catch (error) {
              showCopyableErrorNotice("S3 Sync：解决本地冲突失败", error, "conflict-local");
              logSafeError("S3 Sync local conflict resolution failed", error);
            }
          }));
      for (const [index, candidate] of conflict.remoteCandidates.entries()) {
        const candidateSetting = new Setting(item)
          .setName(`远端候选 ${index + 1}`)
          .setDesc(candidate.kind === "put" ? `Hash ${candidate.hash.slice(0, 12)}，${candidate.size} 字节` : "删除版本");
        if (candidate.kind === "put") {
          candidateSetting.addButton((button) => button
            .setButtonText("打开副本")
            .setIcon("file-search")
            .onClick(async () => {
              await this.runAction(
                "打开冲突候选副本失败",
                "conflict-open-candidate",
                () => this.plugin.openFile(conflictVersionCopyPath(conflict.id, candidate.versionId)),
              );
            }));
        }
        candidateSetting.addButton((button) => button
          .setButtonText(candidate.kind === "delete" ? "使用删除版本" : "使用此版本")
          .onClick(async () => {
            try {
              await this.plugin.resolveConflict(conflict.id, "remote", candidate.versionId);
              new Notice(conflict.remoteDisposition === "concurrent" ? "已使用所选远端版本并合并远端分支" : "已使用远端版本");
              this.render();
            } catch (error) {
              showCopyableErrorNotice("S3 Sync：解决远端冲突失败", error, "conflict-remote");
              logSafeError("S3 Sync remote candidate resolution failed", error);
            }
          }));
      }
    }
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
