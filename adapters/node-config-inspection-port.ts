import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ConfigInspectionPort } from "../core/config-local-inspection";
import { normalizeVaultPath } from "../core/path";

export class NodeConfigInspectionPort implements ConfigInspectionPort {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async stat(path: string): Promise<{ type: "file" | "folder" | "symlink" | "other"; size?: number } | null> {
    try {
      const value = await lstat(this.resolvePath(path));
      if (value.isSymbolicLink()) return { type: "symlink" };
      if (value.isFile()) return { type: "file", size: value.size };
      if (value.isDirectory()) return { type: "folder" };
      return { type: "other" };
    } catch (error) {
      if (hasCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  async list(path: string): Promise<string[]> {
    const normalized = normalizeVaultPath(path);
    const names = await readdir(this.resolvePath(normalized));
    return names.map((name) => normalizeVaultPath(`${normalized}/${name}`));
  }

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.resolvePath(path)));
  }

  private resolvePath(path: string): string {
    const normalized = normalizeVaultPath(path);
    if (isAbsolute(normalized)) throw new Error("config inspection path must be relative");
    const absolute = resolve(this.root, normalized);
    const child = relative(this.root, absolute);
    if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("config inspection path escapes configDir");
    return absolute;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code;
}
