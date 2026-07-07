import { App, PluginSettingTab, Setting } from "obsidian";
import type S3SyncPlugin from "./main";

export class S3SyncSettingTab extends PluginSettingTab {
  private readonly plugin: S3SyncPlugin;

  constructor(app: App, plugin: S3SyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "S3 Sync 设置" });

    new Setting(containerEl)
      .setName("Endpoint")
      .setDesc("S3 Compatible Storage 地址，例如 https://s3.example.com。")
      .addText((text) => text
        .setPlaceholder("https://s3.example.com")
        .setValue(this.plugin.settings.endpoint)
        .onChange(async (value) => {
          this.plugin.settings.endpoint = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Region")
      .setDesc("多数 S3 兼容服务可使用 us-east-1。")
      .addText((text) => text
        .setPlaceholder("us-east-1")
        .setValue(this.plugin.settings.region)
        .onChange(async (value) => {
          this.plugin.settings.region = value.trim() || "us-east-1";
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Bucket")
      .addText((text) => text
        .setPlaceholder("my-vault")
        .setValue(this.plugin.settings.bucket)
        .onChange(async (value) => {
          this.plugin.settings.bucket = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Prefix")
      .setDesc("建议每个 Vault 使用独立前缀。")
      .addText((text) => text
        .setPlaceholder("obsidian-s3-sync")
        .setValue(this.plugin.settings.prefix)
        .onChange(async (value) => {
          this.plugin.settings.prefix = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Access Key ID")
      .addText((text) => text
        .setValue(this.plugin.settings.accessKeyId)
        .onChange(async (value) => {
          this.plugin.settings.accessKeyId = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Secret Access Key")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setValue(this.plugin.settings.secretAccessKey)
          .onChange(async (value) => {
            this.plugin.settings.secretAccessKey = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Path-style")
      .setDesc("MinIO、R2 和不少兼容服务通常需要开启。")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.forcePathStyle)
        .onChange(async (value) => {
          this.plugin.settings.forcePathStyle = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("启动时同步")
      .setDesc("启动后拉取远端变化，并同步事件队列。")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.syncOnStartup)
        .onChange(async (value) => {
          this.plugin.settings.syncOnStartup = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("防抖秒数")
      .setDesc("文件变化后等待一小段时间再同步，避免每次自动保存都上传。")
      .addText((text) => text
        .setValue(String(this.plugin.settings.debounceSeconds))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          this.plugin.settings.debounceSeconds = Number.isFinite(parsed) ? Math.max(1, parsed) : 10;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("忽略规则")
      .setDesc("每行一条，支持 *、**、?。默认忽略 workspace 文件，避免设备布局互相覆盖。")
      .addTextArea((text) => {
        text.inputEl.rows = 8;
        text.inputEl.cols = 48;
        text
          .setValue(this.plugin.settings.ignoredPatterns)
          .onChange(async (value) => {
            this.plugin.settings.ignoredPatterns = value;
            await this.plugin.saveSettings();
          });
      });
  }
}
