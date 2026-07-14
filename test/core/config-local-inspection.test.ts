import { describe, expect, it } from "vitest";
import { createDefaultConfigProfile } from "../../core/config-profile";
import {
  captureLocalConfigSnapshot,
  discoverLocalPluginInventory,
  inspectConfigWorkspaceOnce,
  type ConfigInspectionPort,
} from "../../core/config-local-inspection";

class MemoryConfigPort implements ConfigInspectionPort {
  readonly files = new Map<string, Uint8Array>();
  readonly folders = new Set<string>(["plugins"]);
  readonly symlinks = new Set<string>();
  mutateAfterRead?: () => void;

  async stat(path: string) {
    if (this.symlinks.has(path)) return { type: "symlink" as const };
    if (this.files.has(path)) return { type: "file" as const, size: this.files.get(path)!.byteLength };
    if (this.folders.has(path)) return { type: "folder" as const };
    return null;
  }

  async list(path: string) {
    return [...new Set([
      ...[...this.files.keys()].filter((candidate) => parent(candidate) === path),
      ...[...this.folders].filter((candidate) => parent(candidate) === path),
      ...[...this.symlinks].filter((candidate) => parent(candidate) === path),
    ])];
  }

  async read(path: string) {
    const value = this.files.get(path);
    if (!value) throw new Error("missing");
    const result = new Uint8Array(value);
    this.mutateAfterRead?.();
    this.mutateAfterRead = undefined;
    return result;
  }

  put(path: string, source: string): void {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) this.folders.add(segments.slice(0, index).join("/"));
    this.files.set(path, new TextEncoder().encode(source));
  }
}

describe("local ConfigTree inspection", () => {
  const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
  const descriptorHash = "a".repeat(64);
  const binding = { configDir: ".obsidian", historicalConfigDirs: [] };

  it("captures two equal complete scans and retains exact second-scan bytes", async () => {
    const port = new MemoryConfigPort();
    port.put("app.json", "app");
    port.put("community-plugins.json", "[]");
    const result = await captureLocalConfigSnapshot({
      port,
      profile: createDefaultConfigProfile("1.8.0"),
      previousItems: [],
      repositoryId,
      descriptorHash,
      binding,
      quietWindow: async () => {},
    });
    expect(result).toMatchObject({ status: "captured", items: [{ path: "app.json", kind: "put", size: 3 }] });
    if (result.status !== "captured") throw new Error("expected capture");
    expect(new TextDecoder().decode(result.bytesByPath.get("app.json"))).toBe("app");
    expect(result.treeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats a symlink or changed second scan as retry, never as deletion", async () => {
    const profile = { ...createDefaultConfigProfile("1.8.0"), syncThemes: true };
    const symlink = new MemoryConfigPort();
    symlink.folders.add("themes");
    symlink.symlinks.add("themes/external.css");
    await expect(inspectConfigWorkspaceOnce({ port: symlink, profile })).resolves.toMatchObject({
      observation: { status: "unknown", reason: "本地路径或文件状态无法安全确认。" },
    });

    const changed = new MemoryConfigPort();
    changed.put("app.json", "one");
    let quiet = 0;
    const result = await captureLocalConfigSnapshot({
      port: changed,
      profile: createDefaultConfigProfile("1.8.0"),
      previousItems: [],
      repositoryId,
      descriptorHash,
      binding,
      quietWindow: async () => { quiet += 1; changed.put("app.json", "two"); },
    });
    expect(quiet).toBe(1);
    expect(result).toMatchObject({ status: "retry", reason: "content-changed" });
  });

  it("stops managing projected puts removed from the next profile without inspecting their local node", async () => {
    const port = new MemoryConfigPort();
    port.put("app.json", "app");
    port.put("community-plugins.json", "[]");
    port.symlinks.add("themes/legacy.css");
    const scan = await inspectConfigWorkspaceOnce({
      port,
      profile: createDefaultConfigProfile("1.8.0"),
      previousItems: [{
        path: "themes/legacy.css",
        kind: "put",
        hash: "a".repeat(64),
        size: 1,
        stagedRef: "projected:themes/legacy.css",
      }],
    });
    expect(scan.observation).toMatchObject({ status: "complete" });
    expect(scan.confirmedAbsentPaths).toEqual(new Set());
  });

  it("discovers plugin versions while preserving malformed plugins as device-local diagnostics", async () => {
    const port = new MemoryConfigPort();
    port.put("plugins/good/manifest.json", JSON.stringify({ id: "good", version: "1.2.3", minAppVersion: "1.0.0" }));
    port.put("plugins/bad/manifest.json", "not-json");
    await expect(discoverLocalPluginInventory(port)).resolves.toEqual([
      { directoryId: "bad", error: expect.any(String) },
      { directoryId: "good", manifest: { id: "good", version: "1.2.3", minAppVersion: "1.0.0" } },
    ]);
  });
});

function parent(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}
