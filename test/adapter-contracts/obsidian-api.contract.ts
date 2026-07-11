import type { App, TAbstractFile, Vault, Workspace } from "obsidian";

// Compile-time contract only. Runtime atomicity and suspension behaviour remain pending.
export function assertObsidianApiShape(app: App, vault: Vault, workspace: Workspace, file: TAbstractFile): void {
  const configDir: string = vault.configDir;
  vault.on("rename", (_renamed: TAbstractFile, _oldPath: string) => undefined);
  workspace.on("editor-change", () => undefined);
  void app.fileManager.renameFile(file, "contract-target.md");
  void configDir;
}
