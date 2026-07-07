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
      item.createEl("div", { text: `冲突文件：${conflict.conflictPath}` });
      item.createEl("div", { text: `发现时间：${conflict.detectedAt}` });

      new Setting(item)
        .addButton((button) => button
          .setButtonText("打开当前版本")
          .onClick(async () => {
            await this.plugin.openFile(conflict.path);
          }))
        .addButton((button) => button
          .setButtonText("打开冲突版本")
          .onClick(async () => {
            await this.plugin.openFile(conflict.conflictPath);
          }))
        .addButton((button) => button
          .setButtonText("保留当前")
          .onClick(async () => {
            await this.plugin.resolveConflict(conflict.id, "current");
            new Notice("已保留当前版本");
            this.render();
          }))
        .addButton((button) => button
          .setButtonText("使用冲突版本")
          .setCta()
          .onClick(async () => {
            await this.plugin.resolveConflict(conflict.id, "conflict");
            new Notice("已使用冲突版本");
            this.render();
          }))
        .addButton((button) => button
          .setButtonText("两者都保留")
          .onClick(async () => {
            await this.plugin.resolveConflict(conflict.id, "both");
            new Notice("已标记为两者都保留");
            this.render();
          }));
    }
  }
}
