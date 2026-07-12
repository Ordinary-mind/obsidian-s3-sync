import { Modal, Setting } from "obsidian";
import type { App } from "obsidian";
import type { DesktopRuntimeContractResult } from "./runtime-contract";

export class RuntimeContractModal extends Modal {
  constructor(app: App, private readonly result: DesktopRuntimeContractResult) {
    super(app);
  }

  onOpen(): void {
    const text = [
      "S3 Sync v1 runtime contract",
      `configDir=${this.result.configDir}`,
      `durable write/read=${this.result.durableWriteReadback}`,
      `durable across plugin reload=${this.result.durableAcrossPluginReload === null ? "pending reload" : this.result.durableAcrossPluginReload}`,
      `write/read=${this.result.writeReadback}`,
      `rename=${this.result.rename}`,
      `rename no-clobber=${this.result.renameRejectsExistingTarget}`,
      `copy no-clobber=${this.result.copyRejectsExistingTarget}`,
    ].join("\n");

    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "S3 Sync v1 runtime contract" });
    this.contentEl.createEl("pre", { text });
    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText("Copy result")
        .setCta()
        .onClick(async () => {
          await navigator.clipboard.writeText(text);
          button.setButtonText("Copied");
        }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
