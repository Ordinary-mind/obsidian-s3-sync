import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { S3SyncSettings } from "./types";
import { plaintextCredentialWarning } from "../core/plugin-data";
import { logSafeError, safeConnectionErrorMessage, safeConnectionErrorReport } from "../core/safe-error";
import type S3SyncPlugin from "./main";
import { showCopyableNotice } from "./copyable-notice";

export class S3SyncSettingTab extends PluginSettingTab {
  private readonly plugin: S3SyncPlugin;
  private showAdvanced = false;
  private connectionDraft: Pick<S3SyncSettings,
    "endpoint" | "region" | "bucket" | "prefix" | "forcePathStyle" | "accessKeyId" | "secretAccessKey">;

  constructor(app: App, plugin: S3SyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.connectionDraft = {
      endpoint: plugin.settings.endpoint,
      region: plugin.settings.region,
      bucket: plugin.settings.bucket,
      prefix: plugin.settings.prefix,
      forcePathStyle: plugin.settings.forcePathStyle,
      accessKeyId: plugin.settings.accessKeyId,
      secretAccessKey: plugin.settings.secretAccessKey,
    };
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "S3 Sync 设置" });

    new Setting(containerEl)
      .setName("凭证存储")
      .setDesc(plaintextCredentialWarning());

    new Setting(containerEl)
      .setName("Endpoint")
      .setDesc("只填协议、主机和可选端口，例如 https://s3.example.com。不要带 Bucket、Prefix、路径、查询参数或末尾 /；除本机 MinIO 外必须使用 HTTPS。")
      .addText((text) => text
        .setPlaceholder("https://s3.example.com")
        .setValue(this.connectionDraft.endpoint)
        .onChange(async (value) => {
          this.connectionDraft.endpoint = value.trim();
        }));

    new Setting(containerEl)
      .setName("Region")
      .setDesc("必须与服务端签名区域一致：MinIO 通常为 us-east-1，百度 BOS 广州为 gz，AWS 使用 Bucket 所在区域。")
      .addText((text) => text
        .setPlaceholder("us-east-1")
        .setValue(this.connectionDraft.region)
        .onChange(async (value) => {
          this.connectionDraft.region = value.trim() || "us-east-1";
        }));

    new Setting(containerEl)
      .setName("Bucket")
      .setDesc("只填 Bucket 名称，不要填写 s3://、Endpoint 或目录路径。")
      .addText((text) => text
        .setPlaceholder("my-vault")
        .setValue(this.connectionDraft.bucket)
        .onChange(async (value) => {
          this.connectionDraft.bucket = value.trim();
        }));

    new Setting(containerEl)
      .setName("Access Key ID")
      .setDesc("当前插件设置只支持 Access Key ID 与 Secret Access Key，不支持需要 Session Token 的临时凭证。")
      .addText((text) => text
        .setValue(this.connectionDraft.accessKeyId)
        .onChange((value) => {
          this.connectionDraft.accessKeyId = value.trim();
        }));

    new Setting(containerEl)
      .setName("Secret Access Key")
      .setDesc("只在“检测并应用”成功后保存到本机插件 data.json；不会上传到 S3。")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setValue(this.connectionDraft.secretAccessKey)
          .onChange((value) => {
            this.connectionDraft.secretAccessKey = value;
          });
      });

    const advancedSetting = new Setting(containerEl)
      .setName("高级设置")
      .setDesc(`当前实际 Prefix：${this.plugin.getEffectivePrefix()}`)
      .addButton((button) => button
        .setButtonText(this.showAdvanced ? "隐藏高级设置" : "显示高级设置")
        .onClick(() => {
          this.showAdvanced = !this.showAdvanced;
          this.display();
        }));

    if (this.showAdvanced) {
      new Setting(containerEl)
        .setName("Prefix")
        .setDesc("单 Vault 可留空并按 Vault 名称生成。两台测试 Vault 名称不同时，必须显式填写完全相同的 Prefix 才能连接同一仓库。")
        .addText((text) => text
          .setPlaceholder("留空自动生成")
          .setValue(this.connectionDraft.prefix)
          .onChange((value) => {
            this.connectionDraft.prefix = value.trim();
            advancedSetting.setDesc(`待应用 Prefix：${this.connectionDraft.prefix || "按已确认仓库或 Vault 名称决定"}`);
          }));

      new Setting(containerEl)
        .setName("Path-style")
        .setDesc("当前已验证配置：MinIO 和百度 BOS 开启，AWS 关闭。其他兼容服务必须先通过同一合同测试。")
        .addToggle((toggle) => toggle
          .setValue(this.connectionDraft.forcePathStyle)
          .onChange((value) => {
            this.connectionDraft.forcePathStyle = value;
          }));
    }

    new Setting(containerEl)
      .setName("S3 连接")
      .setDesc("一次完成严格连接检测和保存；全部通过才应用新配置，失败时继续使用旧配置。检测会在当前 Prefix 留下不可变 probe 对象。")
      .addButton((button) => button
        .setButtonText("检测并应用")
        .setCta()
        .onClick(async () => {
          button.setDisabled(true);
          let message: string;
          try {
            message = await this.plugin.testAndApplyConnectionSettings({ ...this.connectionDraft });
          } catch (error) {
            showCopyableNotice(
              `S3 Sync：连接检测失败，未应用新配置：${safeConnectionErrorMessage(error)}`,
              safeConnectionErrorReport(error),
            );
            logSafeError("S3 Sync connection test and apply failed", error);
            return;
          } finally {
            button.setDisabled(false);
          }
          this.connectionDraft = {
            endpoint: this.plugin.settings.endpoint,
            region: this.plugin.settings.region,
            bucket: this.plugin.settings.bucket,
            prefix: this.plugin.settings.prefix,
            forcePathStyle: this.plugin.settings.forcePathStyle,
            accessKeyId: this.plugin.settings.accessKeyId,
            secretAccessKey: this.plugin.settings.secretAccessKey,
          };
          new Notice(`S3 Sync：${message}`);
          this.display();
        }));

    new Setting(containerEl)
      .setName("自动同步")
      .setDesc("关闭时只记录待同步文件，不会自动联网；可通过命令手动同步。")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoSync)
        .onChange(async (value) => {
          try {
            await this.plugin.setAutoSyncEnabled(value);
          } catch (error) {
            this.plugin.reportBackgroundError("自动同步设置保存失败", error, "settings-auto-sync");
            this.display();
          }
        }));

    new Setting(containerEl)
      .setName("配置中心")
      .setDesc("默认只管理 app.json、appearance.json 和 hotkeys.json。远端配置只会被验证和预览，发布或应用都需要你明确确认。")
      .addButton((button) => button
        .setButtonText(`打开 · ${configStatusLabel(this.plugin.getConfigSyncState().status)}`)
        .setIcon("sliders-horizontal")
        .onClick(() => this.plugin.openConfigCenter()));

    if (!this.showAdvanced) {
      return;
    }

    new Setting(containerEl)
      .setName("Vault 文件忽略规则")
      .setDesc("只控制笔记和附件等普通 Vault 文件，不控制配置中心的同步范围。每行一条，支持 *、**、?；configDir 始终从 Vault 文件通道排除，避免重复同步。")
      .addTextArea((text) => {
        text.inputEl.rows = 8;
        text.inputEl.cols = 48;
        text
          .setValue(this.plugin.settings.ignoredPatterns)
          .onChange(async (value) => {
            try {
              await this.plugin.setIgnoredPatterns(value);
            } catch (error) {
              this.plugin.reportBackgroundError("忽略规则保存失败", error, "settings-ignore-rules");
              this.display();
            }
          });
      });

  }
}

function configStatusLabel(status: ReturnType<S3SyncPlugin["getConfigSyncState"]>["status"]): string {
  return {
    unbound: "未连接仓库", ready: "可预览", "local-changes": "本地变化", pending: "等待配置依赖",
    conflict: "ConfigTree 冲突", incompatible: "不兼容", "apply-failed": "应用失败", "recovery-required": "需要恢复", "load-failed": "读取失败",
  }[status];
}
