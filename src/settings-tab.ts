import { App, Notice, PluginSettingTab, Setting, type TextComponent, type ToggleComponent } from "obsidian";
import type { S3SyncSettings } from "./types";
import { plaintextCredentialWarning } from "../core/plugin-data";
import { logSafeError, safeConnectionErrorMessage, safeConnectionErrorReport } from "../core/safe-error";
import type S3SyncPlugin from "./main";
import { showCopyableNotice } from "./copyable-notice";
import { inferS3ConnectionHints, type S3ConnectionHints } from "./connection-hints";

export class S3SyncSettingTab extends PluginSettingTab {
  private readonly plugin: S3SyncPlugin;
  private showAdvanced = false;
  private showOptional = false;
  private editConnection: boolean;
  private connectionDraft: Pick<S3SyncSettings,
    "endpoint" | "region" | "bucket" | "prefix" | "forcePathStyle" | "accessKeyId" | "secretAccessKey">;

  constructor(app: App, plugin: S3SyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.editConnection = !plugin.data.v1;
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

    const connected = this.plugin.data.v1 !== undefined;
    if (connected && !this.editConnection) {
      new Setting(containerEl)
        .setName("S3 连接")
        .setDesc(`已连接并验证 · ${this.plugin.settings.bucket} · ${this.plugin.getEffectivePrefix()}`)
        .addButton((button) => button
          .setButtonText("修改连接")
          .onClick(() => {
            this.editConnection = true;
            this.display();
          }));
    } else {
      this.renderConnectionEditor(containerEl, connected);
    }

    if (!connected) return;

    new Setting(containerEl)
      .setName("自动同步")
      .setDesc("关闭时只记录变化；开启后自动执行同一套先拉取、再上传的安全同步。")
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
      .setName("可选功能")
      .setDesc("Obsidian 设置同步和 Vault 文件忽略规则；不影响基础笔记同步。")
      .addButton((button) => button
        .setButtonText(this.showOptional ? "收起" : "展开")
        .onClick(() => {
          this.showOptional = !this.showOptional;
          this.display();
        }));

    if (!this.showOptional) return;

    new Setting(containerEl)
      .setName("同步 Obsidian 设置")
      .setDesc("可选。默认只管理界面、编辑器和快捷键设置；应用云端设置前一定会显示差异并要求确认。")
      .addButton((button) => button
        .setButtonText(`打开 · ${configStatusLabel(this.plugin.getConfigSyncState().status)}`)
        .setIcon("sliders-horizontal")
        .onClick(() => this.plugin.openConfigCenter()));

    new Setting(containerEl)
      .setName("Vault 文件忽略规则")
      .setDesc("可选。每行一条，支持 *、**、?；这里只控制笔记和附件，不控制 Obsidian 设置同步。")
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

  private renderConnectionEditor(containerEl: HTMLElement, connected: boolean): void {
    let regionInput: TextComponent | undefined;
    let regionSetting: Setting | undefined;
    let pathStyleToggle: ToggleComponent | undefined;
    if (connected) {
      new Setting(containerEl)
        .setName("修改 S3 连接")
        .setDesc("新配置必须全部检测通过才会替换当前连接。")
        .addButton((button) => button
          .setButtonText("取消修改")
          .onClick(() => {
            this.resetConnectionDraft();
            this.editConnection = false;
            this.showAdvanced = false;
            this.display();
          }));
    }

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
          const hints = inferS3ConnectionHints(this.connectionDraft.endpoint);
          if (hints.region) {
            this.connectionDraft.region = hints.region;
            regionInput?.setValue(hints.region);
          }
          if (hints.forcePathStyle !== undefined) {
            this.connectionDraft.forcePathStyle = hints.forcePathStyle;
            pathStyleToggle?.setValue(hints.forcePathStyle);
          }
          regionSetting?.setDesc(regionDescription(hints));
        }));

    regionSetting = new Setting(containerEl)
      .setName("Region")
      .setDesc(regionDescription(inferS3ConnectionHints(this.connectionDraft.endpoint)))
      .addText((text) => {
        regionInput = text;
        text
          .setPlaceholder("us-east-1")
          .setValue(this.connectionDraft.region)
          .onChange(async (value) => {
            this.connectionDraft.region = value.trim() || "us-east-1";
          });
      });

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
        .setDesc("百度 BOS 和本机 MinIO 会自动开启，AWS 会自动关闭；自定义服务可在这里覆盖。")
        .addToggle((toggle) => {
          pathStyleToggle = toggle;
          toggle
            .setValue(this.connectionDraft.forcePathStyle)
            .onChange((value) => {
              this.connectionDraft.forcePathStyle = value;
            });
        });
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
          this.resetConnectionDraft();
          this.editConnection = false;
          this.showAdvanced = false;
          new Notice(`S3 Sync：${message}`);
          this.display();
        }));
  }

  private resetConnectionDraft(): void {
    this.connectionDraft = {
      endpoint: this.plugin.settings.endpoint,
      region: this.plugin.settings.region,
      bucket: this.plugin.settings.bucket,
      prefix: this.plugin.settings.prefix,
      forcePathStyle: this.plugin.settings.forcePathStyle,
      accessKeyId: this.plugin.settings.accessKeyId,
      secretAccessKey: this.plugin.settings.secretAccessKey,
    };
  }
}

function regionDescription(hints: S3ConnectionHints): string {
  if (hints.provider === "baidu") return `已从 Endpoint 识别为百度 BOS，Region 自动填为 ${hints.region}；仍可手动修改。`;
  if (hints.provider === "aws") return hints.region
    ? `已从 Endpoint 识别为 AWS S3，Region 自动填为 ${hints.region}；仍可手动修改。`
    : "已识别为 AWS S3；请填写 Bucket 所在 Region。";
  if (hints.provider === "local") return "已识别为本机 S3 服务，默认使用 us-east-1。";
  return "必须与服务端签名区域一致；自定义 S3 服务请参考供应商文档。";
}

function configStatusLabel(status: ReturnType<S3SyncPlugin["getConfigSyncState"]>["status"]): string {
  return {
    unbound: "未连接仓库", ready: "可检查", "local-changes": "本机设置有变化", pending: "等待云端验证",
    conflict: "设置冲突", incompatible: "不兼容", "apply-failed": "应用失败", "recovery-required": "需要恢复", "load-failed": "读取失败",
  }[status];
}
