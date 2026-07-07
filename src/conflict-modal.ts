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

      const meta = item.createDiv({ cls: "s3-sync-conflict-meta" });
      this.addMeta(meta, "基础 Hash", conflict.baseHash ?? "无");
      this.addMeta(meta, "本地 Hash", conflict.localHash ?? "已删除");
      this.addMeta(meta, "远端 Hash", conflict.remoteHash ?? "已删除");
      this.addMeta(meta, "远端版本", String(conflict.remoteVersion));
      this.addMeta(meta, "发现时间", conflict.detectedAt);

      new Setting(item)
        .addButton((button) => button
          .setButtonText("复制诊断信息")
          .onClick(async () => {
            await navigator.clipboard.writeText([
              `path=${conflict.path}`,
              `baseHash=${conflict.baseHash ?? "null"}`,
              `localHash=${conflict.localHash ?? "null"}`,
              `remoteHash=${conflict.remoteHash ?? "null"}`,
              `remoteVersion=${conflict.remoteVersion}`,
              `detectedAt=${conflict.detectedAt}`,
            ].join("\n"));
            new Notice("已复制冲突诊断信息");
          }))
        .addButton((button) => button
          .setButtonText("打开本地文件")
          .onClick(async () => {
            await this.plugin.openFile(conflict.path);
          }))
        .addButton((button) => button
          .setButtonText("使用本地")
          .setCta()
          .onClick(async () => {
            try {
              await this.plugin.resolveConflict(conflict.id, "local");
              new Notice("已使用本地版本");
              this.render();
            } catch (error) {
              new Notice(`解决冲突失败：${this.errorMessage(error)}`);
              console.error(error);
            }
          }))
        .addButton((button) => button
          .setButtonText("使用远端")
          .onClick(async () => {
            try {
              await this.plugin.resolveConflict(conflict.id, "remote");
              new Notice("已使用远端版本");
              this.render();
            } catch (error) {
              new Notice(`解决冲突失败：${this.errorMessage(error)}`);
              console.error(error);
            }
          }));
    }
  }

  private addMeta(container: HTMLElement, label: string, value: string): void {
    container.createDiv({ cls: "s3-sync-conflict-label", text: label });
    container.createDiv({ cls: "s3-sync-conflict-value", text: value });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
