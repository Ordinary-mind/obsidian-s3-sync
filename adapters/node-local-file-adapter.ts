import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants, copyFile, link, lstat, mkdir, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { LocalFileAdapter, LocalFileCapabilities, LocalFileObservation } from "../core/local-file";
import type { ConfigBatchFileAdapter } from "../core/config-batch-apply";

export class NodeLocalFileAdapter implements LocalFileAdapter, ConfigBatchFileAdapter {
  readonly capabilities: LocalFileCapabilities;
  private readonly root: string;

  constructor(input: {
    root: string;
    platform: "windows" | "macos" | "linux";
    domain: "vault" | "config";
    eventsObservable: boolean;
  }) {
    this.root = resolve(input.root);
    this.capabilities = {
      platform: input.platform,
      domain: input.domain,
      renameToRecovery: true,
      noClobberInstall: true,
      recoveryObservation: true,
      eventsObservable: input.eventsObservable,
      accessMethod: "node-fs",
      renameAtomicity: "link-unlink",
      overwritePolicy: "no-clobber",
      occupiedFileBehavior: "preserve-and-error",
    };
  }

  async observe(path: string): Promise<LocalFileObservation> {
    return observeRegularFile(this.resolveBelowRoot(path));
  }

  async observeRecovery(recoveryRef: string): Promise<LocalFileObservation> {
    return observeRegularFile(this.resolveBelowRoot(recoveryRef));
  }

  async moveToRecovery(path: string, recoveryRef: string): Promise<void> {
    const source = this.resolveBelowRoot(path);
    const target = this.resolveBelowRoot(recoveryRef);
    await mkdir(resolve(target, ".."), { recursive: true });
    try {
      // 硬链接建立与目标存在检查是同一个内核操作；随后 unlink 只移除活动名称。
      await link(source, target);
    } catch (error) {
      if (!hasCode(error, "EEXIST") || !(await sameFileIdentity(source, target))) throw error;
    }
    await unlink(source);
  }

  async installStagedNoClobber(stagedRef: string, path: string): Promise<boolean> {
    return copyNoClobber(this.resolveBelowRoot(stagedRef), this.resolveBelowRoot(path));
  }

  async restoreRecoveryNoClobber(recoveryRef: string, path: string): Promise<boolean> {
    return copyNoClobber(this.resolveBelowRoot(recoveryRef), this.resolveBelowRoot(path));
  }

  async copyToRecoveryNoClobber(path: string, recoveryRef: string): Promise<boolean> {
    return copyNoClobber(this.resolveBelowRoot(path), this.resolveBelowRoot(recoveryRef));
  }

  async inspectNodeNoFollow(path: string): Promise<"absent" | "file" | "folder" | "blocked-by-file" | "symlink" | "other" | "unknown"> {
    const absolute = this.resolveBelowRoot(path);
    const segments = relative(this.root, absolute).split(/[\\/]/);
    let current = this.root;
    for (let index = 0; index < segments.length; index += 1) {
      current = resolve(current, segments[index]);
      let stat;
      try { stat = await lstat(current); }
      catch (error) {
        if (hasCode(error, "ENOENT")) return "absent";
        if (hasCode(error, "ENOTDIR")) return "blocked-by-file";
        return "unknown";
      }
      if (stat.isSymbolicLink()) return "symlink";
      const final = index === segments.length - 1;
      if (!final && !stat.isDirectory()) return stat.isFile() ? "blocked-by-file" : "other";
      if (final) return stat.isFile() ? "file" : stat.isDirectory() ? "folder" : "other";
    }
    return "unknown";
  }

  async materializeConservativeCandidate(stagedRef: string, candidateRef: string): Promise<void> {
    const source = this.resolveBelowRoot(stagedRef);
    const target = this.resolveBelowRoot(candidateRef);
    if (!(await copyNoClobber(source, target))) {
      const [sourceObservation, targetObservation] = await Promise.all([observeRegularFile(source), observeRegularFile(target)]);
      if (sourceObservation.kind !== "present" || targetObservation.kind !== "present"
        || sourceObservation.hash !== targetObservation.hash || sourceObservation.size !== targetObservation.size) {
        throw new Error("conservative candidate path already contains different bytes");
      }
    }
  }

  async removeEmptyDirectoryNoFollow(path: string): Promise<"removed" | "absent" | "not-directory" | "not-empty" | "unknown"> {
    const target = this.resolveBelowRoot(path);
    let stat;
    try { stat = await lstat(target); }
    catch (error) { return hasCode(error, "ENOENT") ? "absent" : "unknown"; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return "not-directory";
    try {
      await rmdir(target);
      return "removed";
    } catch (error) {
      if (hasCode(error, "ENOENT")) return "absent";
      if (hasCode(error, "ENOTEMPTY") || hasCode(error, "EEXIST")) return "not-empty";
      if (hasCode(error, "ENOTDIR")) return "not-directory";
      return "unknown";
    }
  }

  private resolveBelowRoot(path: string): string {
    if (isAbsolute(path)) throw new Error("local adapter path must be relative");
    const absolute = resolve(this.root, path.replace(/\\/g, "/"));
    const child = relative(this.root, absolute);
    if (child === "" || child.startsWith("..") || isAbsolute(child)) throw new Error("local adapter path escapes its root");
    return absolute;
  }
}

async function copyNoClobber(source: string, target: string): Promise<boolean> {
  await mkdir(resolve(target, ".."), { recursive: true });
  try {
    await copyFile(source, target, constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if (hasCode(error, "EEXIST")) return false;
    throw error;
  }
}

async function observeRegularFile(path: string): Promise<LocalFileObservation> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    return hasCode(error, "ENOENT") ? { kind: "absent" } : { kind: "unknown", reason: errorMessage(error) };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return { kind: "unknown", reason: "path is not a regular file" };
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of createReadStream(path)) {
      const bytes = chunk as Buffer;
      hash.update(bytes);
      size += bytes.byteLength;
      if (!Number.isSafeInteger(size)) return { kind: "unknown", reason: "file size exceeds safe integer range" };
    }
  } catch (error) {
    return { kind: "unknown", reason: errorMessage(error) };
  }
  return { kind: "present", hash: hash.digest("hex"), size };
}

async function sameFileIdentity(left: string, right: string): Promise<boolean> {
  try {
    const [leftStat, rightStat] = await Promise.all([lstat(left), lstat(right)]);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino && leftStat.isFile() && rightStat.isFile();
  } catch {
    return false;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
