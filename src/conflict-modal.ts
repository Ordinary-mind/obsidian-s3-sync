import { Modal, Notice, Setting } from "obsidian";
import type S3SyncPlugin from "./main";

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
      item.createEl("div", { text: `基础 Hash：${conflict.baseHash ?? "无"}` });
      item.createEl("div", { text: `本地 Hash：${conflict.localHash ?? "已删除"}` });
      item.createEl("div", { text: `远端 Hash：${conflict.remoteHash ?? "已删除"}` });
      item.createEl("div", { text: `远端版本：${conflict.remoteVersion}` });
      item.createEl("div", { text: `发现时间：${conflict.detectedAt}` });

      new Setting(item)
        .addButton((button) => button
          .setButtonText("打开本地文件")
          .onClick(async () => {
            await this.plugin.openFile(conflict.path);
          }))
        .addButton((button) => button
          .setButtonText("使用本地")
          .setCta()
          .onClick(async () => {
            await this.plugin.resolveConflict(conflict.id, "local");
            new Notice("已使用本地版本");
            this.render();
          }))
        .addButton((button) => button
          .setButtonText("使用远端")
          .onClick(async () => {
            await this.plugin.resolveConflict(conflict.id, "remote");
            new Notice("已使用远端版本");
            this.render();
          }));
    }
  }
}
