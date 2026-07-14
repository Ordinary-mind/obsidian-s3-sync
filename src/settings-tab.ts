import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { S3SyncSettings } from "./types";
import { plaintextCredentialWarning } from "../core/plugin-data";
import type S3SyncPlugin from "./main";

export class S3SyncSettingTab extends PluginSettingTab {
  private readonly plugin: S3SyncPlugin;
  private showAdvanced = false;
  private connectionDraft: Pick<S3SyncSettings, "endpoint" | "region" | "bucket" | "prefix" | "forcePathStyle">;

  constructor(app: App, plugin: S3SyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.connectionDraft = {
      endpoint: plugin.settings.endpoint,
      region: plugin.settings.region,
      bucket: plugin.settings.bucket,
      prefix: plugin.settings.prefix,
      forcePathStyle: plugin.settings.forcePathStyle,
    };
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "S3 Sync 设置" });

    new Setting(containerEl)
      .setName("凭证存储")
      .setDesc(plaintextCredentialWarning({
        kind: "plaintext",
        accessKeyId: this.plugin.settings.accessKeyId,
        secretAccessKey: this.plugin.settings.secretAccessKey,
      })!);

    new Setting(containerEl)
      .setName("Endpoint")
      .setDesc("S3 Compatible Storage 地址，例如 https://s3.example.com。")
      .addText((text) => text
        .setPlaceholder("https://s3.example.com")
        .setValue(this.connectionDraft.endpoint)
        .onChange(async (value) => {
          this.connectionDraft.endpoint = value.trim();
        }));

    new Setting(containerEl)
      .setName("Region")
      .setDesc("多数 S3 兼容服务可使用 us-east-1。")
      .addText((text) => text
        .setPlaceholder("us-east-1")
        .setValue(this.connectionDraft.region)
        .onChange(async (value) => {
          this.connectionDraft.region = value.trim() || "us-east-1";
        }));

    new Setting(containerEl)
      .setName("Bucket")
      .addText((text) => text
        .setPlaceholder("my-vault")
        .setValue(this.connectionDraft.bucket)
        .onChange(async (value) => {
          this.connectionDraft.bucket = value.trim();
        }));

    new Setting(containerEl)
      .setName("应用连接设置")
      .setDesc("已绑定仓库时，路由变化会先停止协调器并重新验证 descriptor 与全部 branch-tip anchors。")
      .addButton((button) => button
        .setButtonText("验证并应用")
        .onClick(async () => {
          try {
            await this.plugin.updateConnectionSettings({ ...this.connectionDraft });
            new Notice("S3 Sync：连接设置已应用。");
          } catch (error) {
            new Notice(`S3 Sync：连接设置未应用：${error instanceof Error ? error.message : String(error)}`);
          }
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
      .setName("检测 S3 连接")
      .setDesc("验证 endpoint、bucket、凭据和当前 Prefix 是否可访问。")
      .addButton((button) => button
        .setButtonText("检测连接")
        .setCta()
        .onClick(async () => {
          await this.plugin.testS3Connection();
        }));

    new Setting(containerEl)
      .setName("自动同步")
      .setDesc("关闭时只记录待同步文件，不会自动联网；可通过命令手动同步。")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoSync)
        .onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("配置同步")
      .setDesc("ConfigTree 只自动下载和验证；应用、插件代码和 plugin data 始终需要显式确认。")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.configSyncEnabled)
        .onChange(async (value) => {
          await this.plugin.setConfigSyncEnabled(value);
          this.display();
        }));

    new Setting(containerEl)
      .setName("配置中心")
      .setDesc(`当前状态：${configStatusLabel(this.plugin.getConfigSyncState().status)}`)
      .addButton((button) => button
        .setButtonText("打开配置中心")
        .setIcon("sliders-horizontal")
        .onClick(() => this.plugin.openConfigCenter()));

    const advancedSetting = new Setting(containerEl)
      .setName("高级设置")
      .setDesc(`当前实际 Prefix：${this.plugin.getEffectivePrefix()}`)
      .addButton((button) => button
        .setButtonText(this.showAdvanced ? "隐藏高级设置" : "显示高级设置")
        .onClick(() => {
          this.showAdvanced = !this.showAdvanced;
          this.display();
        }));

    if (!this.showAdvanced) {
      return;
    }

    containerEl.createEl("h3", { text: "高级设置" });

    new Setting(containerEl)
      .setName("Prefix")
      .setDesc("默认留空即可。只有多个 Vault 同名且共用同一个 Bucket 时，才需要手动指定。")
      .addText((text) => text
        .setPlaceholder("留空自动生成")
        .setValue(this.connectionDraft.prefix)
        .onChange(async (value) => {
          this.connectionDraft.prefix = value.trim();
          advancedSetting.setDesc(`待应用 Prefix：${this.connectionDraft.prefix || "按已确认仓库或 Vault 名称决定"}`);
        }));

    new Setting(containerEl)
      .setName("Path-style")
      .setDesc("MinIO、R2 和不少兼容服务通常需要开启。")
      .addToggle((toggle) => toggle
        .setValue(this.connectionDraft.forcePathStyle)
        .onChange(async (value) => {
          this.connectionDraft.forcePathStyle = value;
        }));

    new Setting(containerEl)
      .setName("启动时同步")
      .setDesc("Obsidian 启动后主动执行一次同步。")
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

function configStatusLabel(status: ReturnType<S3SyncPlugin["getConfigSyncState"]>["status"]): string {
  return {
    disabled: "已关闭", unbound: "未绑定仓库", ready: "可预览", "local-changes": "本地变化", pending: "等待配置依赖",
    conflict: "ConfigTree 冲突", incompatible: "不兼容", "apply-failed": "应用失败", "recovery-required": "需要恢复", "load-failed": "读取失败",
  }[status];
}
