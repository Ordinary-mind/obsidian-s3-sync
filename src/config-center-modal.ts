import { Modal, Notice, Setting, setIcon, type App, type ButtonComponent, type IconName } from "obsidian";
import { detectSensitivePluginData } from "../core/config-compatibility";
import { diffManagedConfigItems, type ConfigDiffEntry } from "../core/config-diff";
import { summarizeConfigProfileTransition } from "../core/config-ui-state";
import type { ConfigProfile } from "../core/types";
import type {
  ConfigApplyPreview,
  ConfigApplyTrustConfirmation,
  ConfigCenterSnapshot,
  ConfigPublicationConfirmation,
  ConfigTreeSourceView,
} from "./config-center-types";
import type S3SyncPlugin from "./main";

type ConfigCenterTab = "profile" | "snapshots" | "merge";

export class ConfigCenterModal extends Modal {
  private activeTab: ConfigCenterTab = "snapshots";
  private snapshot?: ConfigCenterSnapshot;
  private profileDraft: ConfigProfile;
  private selectedRemoteId?: string;
  private busy = false;
  private pluginDataAcknowledged = false;
  private mergeSelections: Record<string, string | "stop-managing"> = {};
  private mergeProfileSourceId = "local";
  private mergeEnabledSourceId = "local";
  private mergeCandidate?: ConfigTreeSourceView;
  private mergeError?: string;

  constructor(private readonly plugin: S3SyncPlugin) {
    super(plugin.app);
    this.profileDraft = structuredClone(plugin.settings.configProfile);
  }

  onOpen(): void {
    this.setTitle("S3 Sync 配置中心");
    this.modalEl.addClass("s3-sync-config-modal");
    this.render();
    void this.refresh();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      this.snapshot = await this.plugin.loadConfigCenterSnapshot();
      this.selectedRemoteId = this.snapshot.resolvedRemoteId ?? this.selectedRemoteId ?? this.snapshot.remote[0]?.id;
      if (!this.snapshot.remote.some((source) => source.id === this.selectedRemoteId)) {
        this.selectedRemoteId = this.snapshot.remote[0]?.id;
      }
      const sourceIds = new Set(["local", ...this.snapshot.remote.map((source) => source.id)]);
      if (!sourceIds.has(this.mergeProfileSourceId)) this.mergeProfileSourceId = "local";
      if (!sourceIds.has(this.mergeEnabledSourceId)) this.mergeEnabledSourceId = "local";
    } catch (error) {
      new Notice(`S3 Sync 配置：${errorMessage(error)}`);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private render(): void {
    this.contentEl.empty();
    this.renderTabs();
    this.renderStatus();
    if (this.activeTab === "profile") this.renderProfile();
    else if (this.activeTab === "merge") this.renderMerge();
    else this.renderSnapshots();
  }

  private renderTabs(): void {
    const tabs = this.contentEl.createDiv({ cls: "s3-sync-config-tabs", attr: { role: "tablist" } });
    for (const [id, label, icon] of [
      ["profile", "Profile", "sliders-horizontal"],
      ["snapshots", "快照与差异", "git-compare-arrows"],
      ["merge", "冲突合并", "git-merge"],
    ] as Array<[ConfigCenterTab, string, IconName]>) {
      const button = tabs.createEl("button", {
        cls: `s3-sync-config-tab${this.activeTab === id ? " is-active" : ""}`,
        attr: { type: "button", role: "tab", "aria-selected": String(this.activeTab === id) },
      });
      setIcon(button, icon);
      button.createSpan({ text: label });
      button.addEventListener("click", () => {
        this.activeTab = id;
        this.render();
      });
    }
  }

  private renderStatus(): void {
    const status = this.snapshot?.state;
    const banner = this.contentEl.createDiv({ cls: `s3-sync-config-status s3-sync-config-status-${status?.status ?? "loading"}` });
    banner.createEl("strong", { text: this.busy ? "正在验证配置快照" : configStatusLabel(status?.status) });
    banner.createSpan({ text: this.busy ? "正在执行本地双扫描和远端依赖验证。" : status?.message ?? "尚未读取配置状态。" });
    if (this.plugin.getConfigSyncState().reloadRequired) {
      banner.createSpan({ cls: "s3-sync-config-reload", text: "配置已写入；请停用受影响插件或重载 Obsidian 后再继续编辑。" });
    }
  }

  private renderProfile(): void {
    const section = this.contentEl.createDiv({ cls: "s3-sync-config-section" });
    section.createEl("h3", { text: "便携配置范围" });

    new Setting(section)
      .setName("配置同步")
      .setDesc("远端配置只下载和预览，不会自动应用。")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.configSyncEnabled)
        .onChange(async (value) => this.run(async () => {
          await this.plugin.setConfigSyncEnabled(value);
          await this.refreshAfterRun();
        })));

    new Setting(section)
      .setName("最低目标 Obsidian 版本")
      .setDesc("目标设备集合中最低的 MAJOR.MINOR.PATCH 版本。")
      .addText((text) => text
        .setPlaceholder("1.8.0")
        .setValue(this.profileDraft.minimumTargetAppVersion ?? "")
        .onChange((value) => {
          this.profileDraft.minimumTargetAppVersion = value.trim();
        }));

    new Setting(section)
      .setName("根级配置文件")
      .setDesc("每行一个 configDir 根级文件名；workspace、core-plugins 和启用列表不可加入。")
      .addTextArea((text) => {
        text.inputEl.rows = 5;
        text.inputEl.cols = 42;
        text.setValue(this.profileDraft.baseFiles.join("\n")).onChange((value) => {
          this.profileDraft.baseFiles = canonicalLines(value);
        });
      });

    new Setting(section)
      .setName("主题")
      .setDesc("管理 themes/ 的完整后代文件。")
      .addToggle((toggle) => toggle.setValue(this.profileDraft.syncThemes).onChange((value) => {
        this.profileDraft.syncThemes = value;
        this.render();
      }));
    new Setting(section)
      .setName("CSS snippets")
      .setDesc("管理 snippets/ 的完整后代文件。")
      .addToggle((toggle) => toggle.setValue(this.profileDraft.syncSnippets).onChange((value) => {
        this.profileDraft.syncSnippets = value;
        this.render();
      }));

    const dataWarning = section.createDiv({ cls: "s3-sync-config-warning" });
    dataWarning.createEl("strong", { text: "plugin data 明文风险" });
    dataWarning.createSpan({ text: detectSensitivePluginData(new Uint8Array()).limitation });
    dataWarning.createSpan({ text: "远端 Bucket 管理员能够读取 data.json 原文；关键字、路径和设备标识检测都不能证明内容安全。" });
    new Setting(dataWarning)
      .setName("允许新增 plugin data 范围")
      .addToggle((toggle) => toggle.setValue(this.pluginDataAcknowledged).onChange((value) => {
        this.pluginDataAcknowledged = value;
        this.render();
      }));

    this.renderPluginScope(section);
    this.renderProfileTransition(section);

    const actions = new Setting(section).setClass("s3-sync-config-actions");
    actions.addButton((button) => this.actionButton(button, {
      label: "保存 Profile",
      icon: "save",
      tooltip: "验证并保存 ConfigProfile",
      disabled: this.busy,
      cta: true,
      onClick: () => this.run(async () => {
        await this.plugin.updateConfigProfile(normalizeProfile(this.profileDraft));
        this.profileDraft = structuredClone(this.plugin.settings.configProfile);
        new Notice("S3 Sync：ConfigProfile 已保存；范围缩小仅停止管理。 ");
        await this.refreshAfterRun();
      }),
    }));
  }

  private renderPluginScope(container: HTMLElement): void {
    container.createEl("h4", { text: "社区插件范围" });
    const entries = new Map((this.snapshot?.inventory ?? []).map((entry) => [entry.directoryId, entry]));
    for (const id of [
      ...this.profileDraft.portablePluginIds,
      ...this.profileDraft.pluginPackages,
      ...this.profileDraft.pluginData,
    ]) if (!entries.has(id)) entries.set(id, { directoryId: id, error: "当前设备未发现插件目录" });
    if (entries.size === 0) {
      container.createDiv({ cls: "s3-sync-empty-state", text: "当前 configDir 未发现社区插件。" });
      return;
    }
    const header = container.createDiv({ cls: "s3-sync-plugin-scope-header" });
    for (const value of ["插件", "便携启用", "插件包", "data.json"]) header.createSpan({ text: value });
    for (const entry of [...entries.values()].sort((left, right) => compareUtf8(left.directoryId, right.directoryId))) {
      const row = container.createDiv({ cls: "s3-sync-plugin-scope-row" });
      const identity = row.createDiv({ cls: "s3-sync-plugin-identity" });
      identity.createEl("code", { text: entry.directoryId });
      identity.createSpan({ text: entry.manifest ? `v${entry.manifest.version}` : entry.error ?? "manifest 无效" });
      const portable = this.profileDraft.portablePluginIds.includes(entry.directoryId);
      this.scopeToggle(row, portable, !!entry.manifest && entry.manifest.id === entry.directoryId, (value) => {
        setMembership(this.profileDraft.portablePluginIds, entry.directoryId, value);
        if (!value) {
          setMembership(this.profileDraft.pluginPackages, entry.directoryId, false);
          setMembership(this.profileDraft.pluginData, entry.directoryId, false);
        }
        this.render();
      });
      this.scopeToggle(row, this.profileDraft.pluginPackages.includes(entry.directoryId), portable, (value) => {
        setMembership(this.profileDraft.pluginPackages, entry.directoryId, value);
        this.render();
      });
      this.scopeToggle(row, this.profileDraft.pluginData.includes(entry.directoryId), portable, (value) => {
        if (value && !this.pluginDataAcknowledged) {
          new Notice("请先确认 plugin data 的明文存储和启发式检测局限。 ");
          return;
        }
        setMembership(this.profileDraft.pluginData, entry.directoryId, value);
        this.render();
      });
    }
  }

  private scopeToggle(container: HTMLElement, value: boolean, enabled: boolean, onChange: (value: boolean) => void): void {
    const cell = container.createDiv({ cls: "s3-sync-plugin-scope-toggle" });
    new Setting(cell).addToggle((toggle) => toggle.setValue(value).setDisabled(!enabled).onChange(onChange));
  }

  private renderProfileTransition(container: HTMLElement): void {
    const transition = summarizeConfigProfileTransition({
      previousProfile: this.plugin.settings.configProfile,
      nextProfile: normalizeProfile(this.profileDraft),
      previousItems: this.snapshot?.local?.items ?? [],
      syncPluginId: this.plugin.manifest.id,
    });
    const summary = container.createDiv({ cls: "s3-sync-profile-transition" });
    summary.createEl("h4", { text: "范围变更结果" });
    summary.createDiv({ text: `停止管理：${transition.stopManaging.length} 个路径（保留本地文件，不发布墓碑）` });
    summary.createDiv({ text: "传播删除：0 个路径（Profile 编辑器不会把范围移除转换为删除）" });
    if (transition.stopManaging.length > 0) this.renderPathList(summary, transition.stopManaging);
    if (transition.violations.length > 0) {
      summary.createDiv({ cls: "s3-sync-error", text: `Profile 校验：${transition.violations.join(", ")}` });
    }
  }

  private renderSnapshots(): void {
    const snapshot = this.snapshot;
    const actions = new Setting(this.contentEl).setClass("s3-sync-config-actions");
    actions.addButton((button) => this.actionButton(button, {
      label: "刷新",
      icon: "refresh-cw",
      tooltip: "重新扫描本地并验证远端 ConfigTree",
      disabled: this.busy,
      onClick: () => this.refresh(),
    }));
    if (!snapshot) {
      this.contentEl.createDiv({ cls: "s3-sync-empty-state", text: "正在读取快照。" });
      return;
    }
    this.renderTreeOverview(snapshot);
    const target = snapshot.remote.find((source) => source.id === this.selectedRemoteId);
    const diff = snapshot.local && target ? diffManagedConfigItems(snapshot.local.items, target.items) : [];
    if (target) this.renderPluginChanges(target);
    this.renderDiff(diff);
    this.renderSnapshotActions(snapshot, target);
    if (snapshot.blockedDetails.length > 0) {
      const blocked = this.contentEl.createDiv({ cls: "s3-sync-config-section" });
      blocked.createEl("h3", { text: "等待依赖" });
      this.renderPathList(blocked, snapshot.blockedDetails);
    }
  }

  private renderTreeOverview(snapshot: ConfigCenterSnapshot): void {
    const section = this.contentEl.createDiv({ cls: "s3-sync-config-section" });
    section.createEl("h3", { text: "ConfigTree" });
    const grid = section.createDiv({ cls: "s3-sync-config-tree-grid" });
    if (snapshot.local) this.renderTreeSummary(grid, snapshot.local, snapshot.projectedTreeHash === snapshot.local.treeHash);
    else grid.createDiv({ cls: "s3-sync-empty-state", text: "本地 Tree 不可用。" });
    const remoteList = grid.createDiv({ cls: "s3-sync-config-tree-column" });
    remoteList.createEl("h4", { text: `远端快照头（${snapshot.state.remoteHeads.length}）` });
    if (snapshot.remote.length === 0) remoteList.createDiv({ cls: "s3-sync-empty-state", text: "远端尚无完整 ConfigTree。" });
    for (const source of snapshot.remote) {
      const item = remoteList.createDiv({ cls: `s3-sync-config-head${source.id === this.selectedRemoteId ? " is-selected" : ""}` });
      const select = item.createEl("button", { text: source.label, attr: { type: "button" } });
      select.addEventListener("click", () => { this.selectedRemoteId = source.id; this.render(); });
      item.createEl("code", { text: source.treeHash });
      item.createSpan({ text: `writer：${source.writerIds.join(", ") || "未知"}` });
      item.createSpan({ text: `版本：${source.versionIds.length}，文件项：${source.items.length}` });
      item.createSpan({ cls: source.compatibility.status === "compatible" ? "s3-sync-ok" : "s3-sync-error", text: source.compatibility.status === "compatible" ? "兼容" : "不兼容" });
    }
  }

  private renderTreeSummary(container: HTMLElement, source: ConfigTreeSourceView, projected: boolean): void {
    const column = container.createDiv({ cls: "s3-sync-config-tree-column" });
    column.createEl("h4", { text: source.label });
    column.createEl("code", { text: source.treeHash });
    column.createSpan({ text: `文件项：${source.items.length}` });
    column.createSpan({ text: `最低 Obsidian：${source.tree.profile.minimumTargetAppVersion}` });
    column.createSpan({ text: `便携插件：${source.tree.profile.portablePluginIds.length}` });
    column.createSpan({ text: projected ? "当前已投影 Tree" : "未投影或已有本地变化" });
  }

  private renderPluginChanges(source: ConfigTreeSourceView): void {
    if (source.pluginChanges.length === 0) return;
    const section = this.contentEl.createDiv({ cls: "s3-sync-config-section s3-sync-plugin-changes" });
    section.createEl("h3", { text: "插件代码与数据" });
    for (const plugin of source.pluginChanges) {
      const row = section.createDiv({ cls: "s3-sync-plugin-change" });
      row.createEl("code", { text: plugin.pluginId });
      row.createSpan({ text: plugin.version ? `v${plugin.version}` : "版本未知" });
      row.createSpan({ text: `来源 writer：${plugin.sourceWriters.join(", ") || "未知"}` });
      row.createSpan({ text: plugin.compatibility === "compatible" ? "兼容" : plugin.compatibility === "incompatible" ? "不兼容" : "兼容性未知" });
      if (plugin.codePaths.length > 0) row.createSpan({ text: `代码文件：${plugin.codePaths.length}` });
      if (plugin.dataPaths.length > 0) row.createSpan({ text: `plugin data：${plugin.dataPaths.length}` });
    }
  }

  private renderDiff(diff: readonly ConfigDiffEntry[]): void {
    const section = this.contentEl.createDiv({ cls: "s3-sync-config-section" });
    section.createEl("h3", { text: `逐文件 diff（${diff.filter((entry) => entry.kind !== "unchanged").length}）` });
    const changed = diff.filter((entry) => entry.kind !== "unchanged");
    if (changed.length === 0) {
      section.createDiv({ cls: "s3-sync-empty-state", text: "本地与所选远端 Tree 相同。" });
      return;
    }
    const list = section.createDiv({ cls: "s3-sync-config-diff" });
    for (const entry of changed) {
      const row = list.createDiv({ cls: `s3-sync-config-diff-row s3-sync-config-diff-${entry.kind}` });
      row.createSpan({ cls: "s3-sync-config-diff-kind", text: diffKindLabel(entry.kind) });
      row.createEl("code", { text: entry.path });
      const flags = row.createDiv({ cls: "s3-sync-config-diff-flags" });
      if (entry.codeChange) flags.createSpan({ text: "插件代码" });
      if (entry.sensitive) flags.createSpan({ text: "明文 plugin data" });
      if (entry.kind === "stop-managing") flags.createSpan({ text: "保留文件，不删除" });
    }
  }

  private renderSnapshotActions(snapshot: ConfigCenterSnapshot, target: ConfigTreeSourceView | undefined): void {
    const section = this.contentEl.createDiv({ cls: "s3-sync-config-section" });
    section.createEl("h3", { text: "快照操作" });
    const actions = new Setting(section).setClass("s3-sync-config-actions");
    if (snapshot.state.status === "recovery-required" && this.plugin.getConfigSyncState().batchJournal) {
      actions.addButton((button) => this.actionButton(button, {
        label: "继续未完成批次",
        icon: "play",
        tooltip: "重新验证远端头和本地前后像后继续原批次",
        disabled: this.busy,
        onClick: () => this.confirmAndRecover("continue", snapshot.recoveryLocation),
      }));
      actions.addButton((button) => this.actionButton(button, {
        label: "回滚未完成批次",
        icon: "undo-2",
        tooltip: "只在本批次后像仍匹配时恢复原前像",
        disabled: this.busy,
        onClick: () => this.confirmAndRecover("rollback", snapshot.recoveryLocation),
      }));
      section.createDiv({ cls: "s3-sync-config-recovery", text: `恢复位置：${snapshot.recoveryLocation}` });
      return;
    }
    if (snapshot.local && (snapshot.state.status === "ready" || snapshot.state.status === "local-changes" || snapshot.state.status === "conflict")) {
      actions.addButton((button) => this.actionButton(button, {
        label: snapshot.state.status === "conflict" ? "选本地树解决" : "发布本地 Tree",
        icon: "upload",
        tooltip: "重新核对全部配置头后发布本地完整 Tree",
        disabled: this.busy,
        onClick: () => this.confirmAndPublish(snapshot.local!, snapshot.state.remoteHeads, true, snapshot.state.status === "conflict"),
      }));
    }
    if (target && snapshot.state.status === "conflict") {
      actions.addButton((button) => this.actionButton(button, {
        label: "选所选远端树解决",
        icon: "git-commit-horizontal",
        tooltip: "发布覆盖全部已观察头的选树解决版本",
        disabled: this.busy,
        onClick: () => this.confirmAndPublish(target, snapshot.state.remoteHeads, false, true),
      }));
      actions.addButton((button) => this.actionButton(button, {
        label: "生成合并树",
        icon: "git-merge",
        tooltip: "逐文件选择来源并生成新的完整 Tree",
        disabled: this.busy,
        onClick: () => { this.activeTab = "merge"; this.render(); },
      }));
    }
    if (target && snapshot.resolvedRemoteId === target.id && target.treeHash !== snapshot.local?.treeHash) {
      actions.addButton((button) => this.actionButton(button, {
        label: "应用所选远端 Tree",
        icon: "download",
        tooltip: "生成恢复快照并按安全批次应用",
        disabled: this.busy || target.compatibility.status !== "compatible",
        cta: true,
        onClick: () => this.confirmAndApply(target),
      }));
    }
    section.createDiv({ cls: "s3-sync-config-recovery", text: `恢复位置：${snapshot.recoveryLocation}` });
  }

  private async confirmAndRecover(action: "continue" | "rollback", recoveryLocation: string): Promise<void> {
    if (!(await requestRecoveryConfirmation(this.app, action, recoveryLocation))) return;
    await this.run(async () => {
      const outcome = await this.plugin.recoverConfigBatch(action);
      new Notice(`S3 Sync 配置：${applyResultLabel(outcome.result.status)}`);
      await this.refreshAfterRun();
    });
  }

  private renderMerge(): void {
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.state.status !== "conflict" || !snapshot.local || snapshot.remote.length < 1) {
      this.contentEl.createDiv({ cls: "s3-sync-empty-state", text: "当前没有可合并的 ConfigTree 冲突。" });
      return;
    }
    const section = this.contentEl.createDiv({ cls: "s3-sync-config-section" });
    section.createEl("h3", { text: "生成合并 ConfigTree" });
    const sources = [snapshot.local, ...snapshot.remote];
    new Setting(section).setName("Profile 来源").addDropdown((dropdown) => {
      for (const source of sources) dropdown.addOption(source.id, source.label);
      dropdown.setValue(this.mergeProfileSourceId).onChange((value) => { this.mergeProfileSourceId = value; this.mergeCandidate = undefined; });
    });
    new Setting(section).setName("便携启用列表来源").addDropdown((dropdown) => {
      for (const source of sources) dropdown.addOption(source.id, source.label);
      dropdown.setValue(this.mergeEnabledSourceId).onChange((value) => { this.mergeEnabledSourceId = value; this.mergeCandidate = undefined; });
    });

    const paths = [...new Set(sources.flatMap((source) => source.items.map((item) => item.path)))].sort(compareUtf8);
    const rows = section.createDiv({ cls: "s3-sync-config-merge-rows" });
    for (const path of paths) {
      const available = sources.filter((source) => source.items.some((item) => item.path === path));
      new Setting(rows)
        .setName(path)
        .setDesc(available.map((source) => `${source.label}: ${itemSummary(source, path)}`).join(" | "))
        .addDropdown((dropdown) => {
          dropdown.addOption("", "请选择来源");
          for (const source of available) dropdown.addOption(source.id, source.label);
          dropdown.addOption("stop-managing", "停止管理（不删除）");
          dropdown.setValue(this.mergeSelections[path] ?? "").onChange((value) => {
            if (value) this.mergeSelections[path] = value;
            else delete this.mergeSelections[path];
            this.mergeCandidate = undefined;
            this.mergeError = undefined;
          });
        });
    }
    const actions = new Setting(section).setClass("s3-sync-config-actions");
    actions.addButton((button) => this.actionButton(button, {
      label: "生成候选",
      icon: "combine",
      tooltip: "验证每个路径选择并构建完整 ConfigTree",
      disabled: this.busy || paths.some((path) => !this.mergeSelections[path]),
      onClick: () => {
        try {
          this.mergeCandidate = this.plugin.buildConfigMergeSource({
            snapshot,
            selections: this.mergeSelections,
            profileSourceId: this.mergeProfileSourceId,
            enabledSourceId: this.mergeEnabledSourceId,
          });
          this.mergeError = undefined;
        } catch (error) {
          this.mergeCandidate = undefined;
          this.mergeError = errorMessage(error);
        }
        this.render();
      },
    }));
    if (this.mergeError) section.createDiv({ cls: "s3-sync-error", text: this.mergeError });
    if (this.mergeCandidate) {
      const candidate = section.createDiv({ cls: "s3-sync-config-merge-result" });
      candidate.createEl("code", { text: this.mergeCandidate.treeHash });
      candidate.createSpan({ text: `文件项：${this.mergeCandidate.items.length}` });
      candidate.createSpan({ text: this.mergeCandidate.compatibility.status === "compatible" ? "当前设备兼容" : "当前设备不兼容" });
      new Setting(candidate).addButton((button) => this.actionButton(button, {
        label: "发布合并 Tree",
        icon: "upload",
        tooltip: "发布覆盖操作时全部已观察头的合并版本",
        disabled: this.busy || this.mergeCandidate?.compatibility.status !== "compatible",
        cta: true,
        onClick: () => this.confirmAndPublish(this.mergeCandidate!, snapshot.state.remoteHeads, false, true),
      }));
    }
  }

  private async confirmAndPublish(
    source: ConfigTreeSourceView,
    observedHeads: string[],
    projectLocal: boolean,
    resolveObservedConflict: boolean,
  ): Promise<void> {
    const confirmation = await requestPublicationConfirmation(this.app, source);
    if (!confirmation) return;
    await this.run(async () => {
      await this.plugin.publishConfigCandidate({ candidate: source, observedHeads, confirmation, projectLocal, resolveObservedConflict });
      new Notice("S3 Sync：ConfigTree 已发布并验证。 ");
      this.mergeCandidate = undefined;
      await this.refreshAfterRun();
    });
  }

  private async confirmAndApply(target: ConfigTreeSourceView): Promise<void> {
    await this.run(async () => {
      const preview = await this.plugin.prepareConfigApply(target.treeHash);
      const confirmation = await requestApplyConfirmation(this.app, preview);
      if (!confirmation) return;
      const outcome = await this.plugin.applyConfigPreview(preview, confirmation);
      if (outcome.result.status === "accounted" || outcome.result.status === "adopted-without-write") {
        new Notice(outcome.state.reloadRequired
          ? "S3 Sync：配置已应用。请停用受影响插件或重载 Obsidian。"
          : "S3 Sync：配置 Tree 已采用，无需写入文件。 ");
      } else {
        new Notice(`S3 Sync 配置：${applyResultLabel(outcome.result.status)}`);
      }
      await this.refreshAfterRun();
    });
  }

  private renderPathList(container: HTMLElement, paths: readonly string[]): void {
    const list = container.createEl("ul", { cls: "s3-sync-config-path-list" });
    for (const path of paths) list.createEl("li").createEl("code", { text: path });
  }

  private actionButton(button: ButtonComponent, input: {
    label: string;
    icon: IconName;
    tooltip: string;
    disabled: boolean;
    cta?: boolean;
    onClick: () => void | Promise<void>;
  }): void {
    button.setButtonText(input.label).setIcon(input.icon).setTooltip(input.tooltip).setDisabled(input.disabled).onClick(input.onClick);
    if (input.cta) button.setCta();
  }

  private async run(operation: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try { await operation(); }
    catch (error) {
      new Notice(`S3 Sync 配置：${errorMessage(error)}`);
      console.error(error);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async refreshAfterRun(): Promise<void> {
    this.busy = false;
    await this.refresh();
    this.busy = true;
  }
}

class PublicationConfirmationModal extends Modal {
  private settled = false;
  private general = false;
  private code = false;
  private data = false;

  constructor(app: App, private readonly source: ConfigTreeSourceView, private readonly resolveResult: (value: ConfigPublicationConfirmation | undefined) => void) {
    super(app);
  }

  onOpen(): void { this.render(); }
  onClose(): void { if (!this.settled) this.resolveResult(undefined); }

  private render(): void {
    this.setTitle("确认发布 ConfigTree");
    this.contentEl.empty();
    const diff = diffManagedConfigItems([], this.source.items);
    const needsCode = diff.some((entry) => entry.codeChange);
    const needsData = diff.some((entry) => entry.sensitive);
    this.contentEl.createEl("code", { text: this.source.treeHash });
    this.contentEl.createDiv({ text: `文件项：${this.source.items.length}，来源 writer：${this.source.writerIds.join(", ") || "本机"}` });
    if (needsCode) this.contentEl.createDiv({ cls: "s3-sync-config-warning", text: "该 Tree 包含可执行插件代码；接收设备应用后代码可在 Obsidian 中运行。" });
    if (needsData) this.contentEl.createDiv({ cls: "s3-sync-config-warning", text: detectSensitivePluginData(new Uint8Array()).limitation });
    new Setting(this.contentEl).setName("确认发布完整 Tree").addToggle((toggle) => toggle.setValue(this.general).onChange((value) => { this.general = value; this.render(); }));
    if (needsCode) new Setting(this.contentEl).setName("接受插件代码风险").addToggle((toggle) => toggle.setValue(this.code).onChange((value) => { this.code = value; this.render(); }));
    if (needsData) new Setting(this.contentEl).setName("接受 plugin data 明文存储").addToggle((toggle) => toggle.setValue(this.data).onChange((value) => { this.data = value; this.render(); }));
    new Setting(this.contentEl).addButton((button) => button
      .setButtonText("发布并验证")
      .setIcon("upload")
      .setCta()
      .setDisabled(!this.general || needsCode && !this.code || needsData && !this.data)
      .onClick(() => {
        this.settled = true;
        this.resolveResult({ treeHash: this.source.treeHash, acceptPluginCode: this.code, acceptSensitiveData: this.data });
        this.close();
      }));
  }
}

class ApplyConfirmationModal extends Modal {
  private settled = false;
  private general = false;
  private code = false;
  private data = false;
  private loaded = false;
  private newPlugins = false;

  constructor(app: App, private readonly preview: ConfigApplyPreview, private readonly resolveResult: (value: ConfigApplyTrustConfirmation | undefined) => void) {
    super(app);
  }

  onOpen(): void { this.render(); }
  onClose(): void { if (!this.settled) this.resolveResult(undefined); }

  private render(): void {
    this.setTitle("确认应用 ConfigTree");
    this.contentEl.empty();
    const writes = this.preview.plan.operations.filter((operation) => operation.target.kind === "put").length;
    const deletes = this.preview.plan.operations.filter((operation) => operation.target.kind === "delete").length;
    const stops = this.preview.plan.operations.filter((operation) => operation.target.kind === "stop-managing").length;
    const summary = this.contentEl.createDiv({ cls: "s3-sync-status-grid" });
    for (const [label, value] of [
      ["写入", String(writes)], ["删除", String(deletes)], ["停止管理", String(stops)],
      ["恢复位置", this.preview.recoveryLocation], ["目标 Tree", this.preview.target.treeHash],
    ]) {
      summary.createDiv({ cls: "s3-sync-status-label", text: label });
      summary.createDiv({ cls: "s3-sync-status-value", text: value });
    }
    if (this.preview.requirements.pluginData) this.contentEl.createDiv({ cls: "s3-sync-config-warning", text: detectSensitivePluginData(new Uint8Array()).limitation });
    if (this.preview.requirements.loadedPlugins) this.contentEl.createDiv({ cls: "s3-sync-config-warning", text: "批次会修改当前启用插件的代码或 data.json；应先停用对应插件，应用后重载 Obsidian。" });
    new Setting(this.contentEl).setName("确认按预览应用完整批次").addToggle((toggle) => toggle.setValue(this.general).onChange((value) => { this.general = value; this.render(); }));
    if (this.preview.requirements.pluginCode) this.trustToggle("接受插件代码变化", "code");
    if (this.preview.requirements.pluginData) this.trustToggle("接受 plugin data 明文与敏感信息风险", "data");
    if (this.preview.requirements.loadedPlugins) this.trustToggle("接受已加载插件变化并将在应用后重载", "loaded");
    if (this.preview.requirements.newPlugins) this.trustToggle("接受新增插件包与启用状态", "newPlugins");
    const ready = this.general
      && (!this.preview.requirements.pluginCode || this.code)
      && (!this.preview.requirements.pluginData || this.data)
      && (!this.preview.requirements.loadedPlugins || this.loaded)
      && (!this.preview.requirements.newPlugins || this.newPlugins);
    new Setting(this.contentEl).addButton((button) => button
      .setButtonText("创建恢复快照并应用")
      .setIcon("shield-check")
      .setCta()
      .setDisabled(!ready)
      .onClick(() => {
        this.settled = true;
        this.resolveResult({
          planHash: this.preview.planHash,
          acceptPluginCode: this.code,
          acceptSensitiveData: this.data,
          acceptLoadedPluginChanges: this.loaded,
          acceptNewPlugins: this.newPlugins,
        });
        this.close();
      }));
  }

  private trustToggle(label: string, key: "code" | "data" | "loaded" | "newPlugins"): void {
    new Setting(this.contentEl).setName(label).addToggle((toggle) => toggle.setValue(this[key]).onChange((value) => { this[key] = value; this.render(); }));
  }
}

class RecoveryConfirmationModal extends Modal {
  private settled = false;
  private confirmed = false;

  constructor(
    app: App,
    private readonly action: "continue" | "rollback",
    private readonly recoveryLocation: string,
    private readonly resolveResult: (value: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void { this.render(); }
  onClose(): void { if (!this.settled) this.resolveResult(false); }

  private render(): void {
    const continuing = this.action === "continue";
    this.setTitle(continuing ? "继续配置批次" : "回滚配置批次");
    this.contentEl.empty();
    this.contentEl.createDiv({
      cls: "s3-sync-config-warning",
      text: continuing
        ? "继续前会重新验证仓库、远端 ConfigTree 头和每个本地前后像；任一变化都会停止并保留恢复副本。"
        : "回滚只会移动仍匹配本批次后像的文件；检测到并发编辑时会停止并保留当前文件。",
    });
    this.contentEl.createDiv({ cls: "s3-sync-config-recovery", text: `恢复位置：${this.recoveryLocation}` });
    new Setting(this.contentEl)
      .setName(continuing ? "确认继续原批次" : "确认按 Journal 回滚")
      .addToggle((toggle) => toggle.setValue(this.confirmed).onChange((value) => {
        this.confirmed = value;
        this.render();
      }));
    new Setting(this.contentEl).addButton((button) => button
      .setButtonText(continuing ? "重新验证并继续" : "验证后回滚")
      .setIcon(continuing ? "play" : "undo-2")
      .setCta()
      .setDisabled(!this.confirmed)
      .onClick(() => {
        this.settled = true;
        this.resolveResult(true);
        this.close();
      }));
  }
}

function requestPublicationConfirmation(app: App, source: ConfigTreeSourceView): Promise<ConfigPublicationConfirmation | undefined> {
  return new Promise((resolve) => new PublicationConfirmationModal(app, source, resolve).open());
}

function requestApplyConfirmation(app: App, preview: ConfigApplyPreview): Promise<ConfigApplyTrustConfirmation | undefined> {
  return new Promise((resolve) => new ApplyConfirmationModal(app, preview, resolve).open());
}

function requestRecoveryConfirmation(app: App, action: "continue" | "rollback", recoveryLocation: string): Promise<boolean> {
  return new Promise((resolve) => new RecoveryConfirmationModal(app, action, recoveryLocation, resolve).open());
}

function normalizeProfile(profile: ConfigProfile): ConfigProfile {
  return {
    ...structuredClone(profile),
    baseFiles: sortedUnique(profile.baseFiles),
    portablePluginIds: sortedUnique(profile.portablePluginIds),
    pluginPackages: sortedUnique(profile.pluginPackages),
    pluginData: sortedUnique(profile.pluginData),
  };
}

function canonicalLines(value: string): string[] {
  return sortedUnique(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
}

function setMembership(values: string[], id: string, enabled: boolean): void {
  const next = new Set(values);
  if (enabled) next.add(id); else next.delete(id);
  values.splice(0, values.length, ...[...next].sort(compareUtf8));
}

function sortedUnique(values: readonly string[]): string[] { return [...new Set(values)].sort(compareUtf8); }

function configStatusLabel(status: ConfigCenterSnapshot["state"]["status"] | "loading" | undefined): string {
  const labels: Record<ConfigCenterSnapshot["state"]["status"] | "loading", string> = {
    loading: "读取中", disabled: "配置同步已关闭", unbound: "未绑定仓库", ready: "可预览",
    "local-changes": "本地配置变化", pending: "配置依赖待定", conflict: "ConfigTree 冲突",
    incompatible: "配置不兼容", "apply-failed": "配置应用失败", "recovery-required": "需要配置恢复", "load-failed": "配置读取失败",
  };
  return labels[status ?? "loading"];
}

function diffKindLabel(kind: ConfigDiffEntry["kind"]): string {
  return { add: "新增", modify: "修改", delete: "传播删除", "stop-managing": "停止管理", unchanged: "相同" }[kind];
}

function applyResultLabel(status: Awaited<ReturnType<S3SyncPlugin["applyConfigPreview"]>>["result"]["status"]): string {
  const labels = {
    accounted: "配置已应用", "adopted-without-write": "已无写入采用", "stale-plan": "预览已过期",
    "confirmation-required": "确认项不完整", "local-change": "本地配置已变化", "conservative-only": "当前平台仅支持候选",
    "rolled-back": "应用失败并已回滚", "recovery-required": "需要人工恢复",
  } as const;
  return labels[status];
}

function itemSummary(source: ConfigTreeSourceView, path: string): string {
  const item = source.items.find((candidate) => candidate.path === path);
  return item?.kind === "put" ? `put ${item.hash.slice(0, 8)}` : "delete";
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder(); const a = encoder.encode(left); const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return a.length - b.length;
}
