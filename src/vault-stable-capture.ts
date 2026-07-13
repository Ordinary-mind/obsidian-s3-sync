import { TFile, Vault } from "obsidian";
import { captureStableBytes, type StableCapture } from "../core/stable-capture";

export async function captureStableVaultFile(vault: Vault, path: string): Promise<StableCapture | undefined> {
  return captureStableBytes(async () => {
    const entry = vault.getAbstractFileByPath(path);
    if (!entry) return { type: "missing" };
    if (!(entry instanceof TFile)) return { type: "other" };
    return { type: "file", bytes: new Uint8Array(await vault.readBinary(entry)) };
  });
}
