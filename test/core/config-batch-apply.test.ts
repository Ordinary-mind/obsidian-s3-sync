import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../protocol/hash";
import { SafeConfigBatchApplicator, configBatchPlanHash, orderConfigOperations, type ConfigBatchFileAdapter, type ConfigBatchGuard, type ConfigBatchJournal, type ConfigBatchOperation, type ConfigBatchPlan, type ConfigBatchStateStore } from "../../core/config-batch-apply";
import type { LocalFileObservation } from "../../core/local-file";

class MemoryConfigFiles implements ConfigBatchFileAdapter {
  readonly capabilities = {
    platform: "linux", domain: "config", renameToRecovery: true, noClobberInstall: true,
    recoveryObservation: true, eventsObservable: true, accessMethod: "node-fs", renameAtomicity: "link-unlink",
    overwritePolicy: "no-clobber", occupiedFileBehavior: "preserve-and-error",
  } as const;
  readonly active = new Map<string, Uint8Array>();
  readonly staged = new Map<string, Uint8Array>();
  readonly recovery = new Map<string, Uint8Array>();
  readonly folders = new Set<string>();
  readonly log: string[] = [];
  failInstallPath?: string;
  mutateBeforeRollback?: { path: string; bytes: Uint8Array };

  async observe(path: string): Promise<LocalFileObservation> {
    if (this.active.has(path)) return observation(this.active.get(path));
    if (this.folders.has(path) || [...this.active.keys()].some((candidate) => candidate.startsWith(`${path}/`))
      || ancestors(path).some((ancestor) => this.active.has(ancestor))) {
      return { kind: "unknown", reason: "path is not directly observable as a regular file" };
    }
    return { kind: "absent" };
  }
  async observeRecovery(path: string): Promise<LocalFileObservation> { return observation(this.recovery.get(path)); }
  async copyToRecoveryNoClobber(path: string, ref: string): Promise<boolean> {
    this.log.push(`snapshot:${path}`);
    if (this.recovery.has(ref)) return false;
    const value = this.active.get(path); if (!value) throw new Error("missing snapshot source");
    this.recovery.set(ref, new Uint8Array(value)); return true;
  }
  async moveToRecovery(path: string, ref: string): Promise<void> {
    this.log.push(`move:${path}`);
    const value = this.active.get(path); if (!value || this.recovery.has(ref)) throw new Error("move failed");
    this.active.delete(path); this.recovery.set(ref, value);
  }
  async installStagedNoClobber(ref: string, path: string): Promise<boolean> {
    this.log.push(`install:${path}`);
    if (this.failInstallPath === path) {
      this.failInstallPath = undefined;
      if (this.mutateBeforeRollback) this.active.set(this.mutateBeforeRollback.path, this.mutateBeforeRollback.bytes);
      throw new Error("injected install failure");
    }
    if (this.active.has(path) || this.folders.has(path) || ancestors(path).some((ancestor) => this.active.has(ancestor))) return false;
    const value = this.staged.get(ref); if (!value) throw new Error("missing stage");
    this.addParentFolders(path);
    this.active.set(path, new Uint8Array(value)); return true;
  }
  async restoreRecoveryNoClobber(ref: string, path: string): Promise<boolean> {
    this.log.push(`restore:${path}`);
    if (this.active.has(path)) return false;
    const value = this.recovery.get(ref); if (!value) return false;
    this.addParentFolders(path);
    this.active.set(path, new Uint8Array(value)); return true;
  }
  async materializeConservativeCandidate(): Promise<void> { throw new Error("unused"); }
  async inspectNodeNoFollow(path: string) {
    if (this.active.has(path)) return "file" as const;
    if ([...this.active.keys()].some((candidate) => candidate.startsWith(`${path}/`)) || this.folders.has(path)) return "folder" as const;
    if (ancestors(path).some((ancestor) => this.active.has(ancestor))) return "blocked-by-file" as const;
    return "absent" as const;
  }
  async removeEmptyDirectoryNoFollow(path: string) {
    if ([...this.active.keys()].some((candidate) => candidate.startsWith(`${path}/`))) return "not-empty" as const;
    if (!this.folders.delete(path)) return "absent" as const;
    return "removed" as const;
  }
  private addParentFolders(path: string): void {
    for (const ancestor of ancestors(path)) this.folders.add(ancestor);
  }
}

class MemoryConfigState implements ConfigBatchStateStore {
  guardValue: ConfigBatchGuard;
  journals: ConfigBatchJournal[] = [];
  accounted = 0;
  dirty = 0;
  dirtyBases: Array<{ heads: string[]; treeHash: string | null }> = [];
  recoveryRequired = 0;
  crashWhen?: (journal: ConfigBatchJournal) => boolean;
  constructor(plan: ConfigBatchPlan) {
    this.guardValue = { repositoryFingerprint: plan.repositoryFingerprint, observedHeads: [...plan.targetHeads], projectedTreeHash: plan.projectedTreeHash, currentTreeHash: plan.projectedTreeHash, hasDirtyIntent: false };
  }
  async guard() { return structuredClone(this.guardValue); }
  async persistJournal(journal: ConfigBatchJournal) {
    if (this.crashWhen?.(journal)) { this.crashWhen = undefined; throw new Error("crash"); }
    this.journals.push(structuredClone(journal));
  }
  async accountProjection() { this.accounted += 1; }
  async markConfigDirtyIntent(heads: readonly string[], treeHash: string | null) {
    this.dirty += 1;
    this.dirtyBases.push({ heads: [...heads], treeHash });
  }
  async markRecoveryRequired() { this.recoveryRequired += 1; }
}

describe("safe ConfigTree batch apply", () => {
  it("previews without writes, snapshots every before-image, installs packages before enablement, and accounts after reload", async () => {
    const plan = batchPlan();
    const files = seededFiles();
    const state = new MemoryConfigState(plan);
    const engine = applicator(files, state, plan.targetTreeHash);
    const preview = engine.preview(plan);
    expect(preview.writesFormalConfig).toBe(false);
    expect(files.log).toEqual([]);
    const result = await engine.apply(plan, confirmation(plan));
    expect(result.status).toBe("accounted");
    const firstMove = files.log.findIndex((entry) => entry.startsWith("move:"));
    expect(files.log.slice(0, firstMove)).toEqual(["snapshot:plugins/p/main.js", "snapshot:community-plugins.json"]);
    expect(files.log.filter((entry) => entry.startsWith("install:"))).toEqual(["install:plugins/p/main.js", "install:community-plugins.json"]);
    expect(state.accounted).toBe(1);
  });

  it("rolls back every applied item after a mid-batch failure and never advances projection", async () => {
    const plan = batchPlan();
    const files = seededFiles();
    files.failInstallPath = "community-plugins.json";
    const state = new MemoryConfigState(plan);
    const result = await applicator(files, state, plan.targetTreeHash).apply(plan, confirmation(plan));
    expect(result.status).toBe("rolled-back");
    expect(text(files.active.get("plugins/p/main.js")!)).toBe("old-code");
    expect(text(files.active.get("community-plugins.json")!)).toBe("old-enabled");
    expect(state.accounted).toBe(0);
    expect(state.dirty).toBe(1);
  });

  it("preserves a concurrent edit during rollback and enters recovery-required", async () => {
    const plan = batchPlan();
    const files = seededFiles();
    files.failInstallPath = "community-plugins.json";
    files.mutateBeforeRollback = { path: "plugins/p/main.js", bytes: bytes("user-edit") };
    const state = new MemoryConfigState(plan);
    const result = await applicator(files, state, plan.targetTreeHash).apply(plan, confirmation(plan));
    expect(result.status).toBe("recovery-required");
    expect(text(files.active.get("plugins/p/main.js")!)).toBe("user-edit");
    expect(state.accounted).toBe(0);
    expect(state.recoveryRequired).toBe(1);
  });

  it("requires exact risk confirmation and rolls back when reloaded Tree differs", async () => {
    const plan = batchPlan();
    const files = seededFiles();
    const state = new MemoryConfigState(plan);
    await expect(applicator(files, state, plan.targetTreeHash).apply(plan, { ...confirmation(plan), acceptPluginCode: false }))
      .resolves.toEqual({ status: "confirmation-required" });
    expect(files.log).toEqual([]);
    expect(state.journals).toEqual([]);
    expect(state.accounted).toBe(0);
    const result = await applicator(files, state, "c".repeat(64)).apply(plan, confirmation(plan));
    expect(result.status).toBe("rolled-back");
    expect(state.accounted).toBe(0);
  });

  it("captures local divergence against projected heads without absorbing target heads", async () => {
    const plan = batchPlan();
    const files = seededFiles();
    const state = new MemoryConfigState(plan);
    state.guardValue.currentTreeHash = "c".repeat(64);
    const result = await applicator(files, state, plan.targetTreeHash).apply(plan, confirmation(plan));
    expect(result.status).toBe("local-change");
    expect(state.dirtyBases).toEqual([{ heads: ["projected-head"], treeHash: plan.projectedTreeHash }]);
    expect(files.log).toEqual([]);
  });

  it("requires explicit trust for a new plugin before touching formal config", async () => {
    const plan = { ...batchPlan(), newPluginIds: ["new-plugin"] };
    const files = seededFiles();
    const state = new MemoryConfigState(plan);
    const result = await applicator(files, state, plan.targetTreeHash).apply(plan, { ...confirmation(plan), acceptNewPlugins: false });
    expect(result.status).toBe("confirmation-required");
    expect(files.log).toEqual([]);
    expect(state.accounted).toBe(0);
  });

  it("verifies every staged put before persisting a Journal or writing formal config", async () => {
    const plan = batchPlan();
    const files = seededFiles();
    files.staged.delete("staged/community-plugins.json");
    const state = new MemoryConfigState(plan);
    await expect(applicator(files, state, plan.targetTreeHash).apply(plan, confirmation(plan))).rejects.toThrow("stage mismatch");
    expect(files.log).toEqual([]);
    expect(state.journals).toEqual([]);
    expect(state.accounted).toBe(0);
  });

  it("continues the same batch safely after a crash between an item after-image and Journal progress", async () => {
    const plan = batchPlan();
    const files = seededFiles();
    const state = new MemoryConfigState(plan);
    state.crashWhen = (journal) => journal.state === "applying" && journal.nextOperation === 1;
    const engine = applicator(files, state, plan.targetTreeHash);
    await expect(engine.apply(plan, confirmation(plan))).rejects.toThrow("crash");
    const persisted = state.journals.at(-1)!;
    expect(persisted).toMatchObject({ state: "applying", nextOperation: 0 });
    const result = await engine.recover(persisted, "continue");
    expect(result.status).toBe("accounted");
    expect(text(files.active.get("plugins/p/main.js")!)).toBe("new-code");
    expect(text(files.active.get("community-plugins.json")!)).toBe("new-enabled");
  });

  it("orders all deep deletes before shallow puts in both shape-change directions", () => {
    const base = operation("a", "x", "y");
    const ordered = orderConfigOperations([
      { ...base, path: "x", target: { kind: "delete" } },
      { ...base, path: "x/y", target: { kind: "delete" } },
      { ...base, path: "z/y", target: base.target },
      { ...base, path: "z", target: base.target },
      { ...base, path: "reverse/child", target: { kind: "delete" } },
      { ...base, path: "reverse", target: base.target },
    ]);
    expect(ordered.map((item) => item.path)).toEqual(["reverse/child", "x/y", "x", "reverse", "z", "z/y"]);
  });

  it("applies file-to-directory and directory-to-file shape changes without following unknown nodes", async () => {
    const { plan, files } = shapeChangeFixture();
    const state = new MemoryConfigState(plan);
    const result = await applicator(files, state, plan.targetTreeHash).apply(plan, confirmation(plan));
    expect(result.status).toBe("accounted");
    expect(text(files.active.get("to-dir/child")!)).toBe("new-child");
    expect(text(files.active.get("to-file")!)).toBe("new-parent");
    expect(files.active.has("to-dir")).toBe(false);
    expect(files.active.has("to-file/child")).toBe(false);
  });

  it("rolls both shape-change directions back after a later install failure", async () => {
    const { plan, files } = shapeChangeFixture();
    files.failInstallPath = "to-dir/child";
    const state = new MemoryConfigState(plan);
    const result = await applicator(files, state, plan.targetTreeHash).apply(plan, confirmation(plan));
    expect(result.status).toBe("rolled-back");
    expect(text(files.active.get("to-dir")!)).toBe("old-parent");
    expect(text(files.active.get("to-file/child")!)).toBe("old-child");
    expect(files.active.has("to-dir/child")).toBe(false);
    expect(files.active.has("to-file")).toBe(false);
    expect(state.accounted).toBe(0);
  });

  it("never writes formal config through an unverified conservative adapter", async () => {
    const plan = batchPlan();
    const files = seededFiles();
    Object.assign(files.capabilities, { noClobberInstall: false, overwritePolicy: "unsupported" });
    const state = new MemoryConfigState(plan);
    const result = await applicator(files, state, plan.targetTreeHash).apply(plan, confirmation(plan));
    expect(result.status).toBe("conservative-only");
    expect(files.log).toEqual([]);
    expect(state.accounted).toBe(0);
  });

  it("allows a guarded desktop config batch without generic file events", async () => {
    const plan = batchPlan();
    const files = seededFiles();
    Object.assign(files.capabilities, { eventsObservable: false });
    const state = new MemoryConfigState(plan);
    const result = await applicator(files, state, plan.targetTreeHash).apply(plan, confirmation(plan));
    expect(result.status).toBe("accounted");
    expect(state.accounted).toBe(1);
  });
});

function batchPlan(): ConfigBatchPlan {
  const operations = [
    operation("community-plugins.json", "old-enabled", "new-enabled"),
    { ...operation("plugins/p/main.js", "old-code", "new-code"), pluginId: "p", loadedPlugin: true },
  ];
  return {
    id: "batch",
    repositoryFingerprint: "fingerprint",
    targetHeads: ["config-head"],
    projectedHeads: ["projected-head"],
    projectedTreeHash: "a".repeat(64),
    targetTreeHash: "b".repeat(64),
    operations,
    diff: [{ path: "plugins/p/main.js", kind: "modify", codeChange: true, sensitive: false }],
    newPluginIds: [],
  };
}

function operation(path: string, before: string, after: string): ConfigBatchOperation {
  return {
    path,
    expected: { kind: "present", hash: hash(before), size: bytes(before).byteLength },
    target: { kind: "put", hash: hash(after), size: bytes(after).byteLength, stagedRef: `staged/${path}` },
  };
}

function present(value: Uint8Array): ConfigBatchOperation["expected"] {
  return { kind: "present", hash: hashBytes(value), size: value.byteLength };
}

function put(stagedRef: string, value: Uint8Array): Extract<ConfigBatchOperation["target"], { kind: "put" }> {
  return { kind: "put", hash: hashBytes(value), size: value.byteLength, stagedRef };
}

function shapeChangeFixture(): { plan: ConfigBatchPlan; files: MemoryConfigFiles } {
  const oldParent = bytes("old-parent");
  const oldChild = bytes("old-child");
  const newParent = bytes("new-parent");
  const newChild = bytes("new-child");
  const operations: ConfigBatchOperation[] = [
    { path: "to-dir", expected: present(oldParent), target: { kind: "delete" } },
    { path: "to-dir/child", expected: { kind: "absent" }, target: put("staged/new-child", newChild) },
    { path: "to-file/child", expected: present(oldChild), target: { kind: "delete" } },
    { path: "to-file", expected: { kind: "absent" }, target: put("staged/new-parent", newParent) },
  ];
  const plan = { ...batchPlan(), operations, diff: [], projectedTreeHash: "a".repeat(64), targetTreeHash: "b".repeat(64) };
  const files = new MemoryConfigFiles();
  files.active.set("to-dir", oldParent);
  files.active.set("to-file/child", oldChild);
  files.folders.add("to-file");
  files.staged.set("staged/new-child", newChild);
  files.staged.set("staged/new-parent", newParent);
  return { plan, files };
}

function seededFiles(): MemoryConfigFiles {
  const files = new MemoryConfigFiles();
  files.active.set("plugins/p/main.js", bytes("old-code"));
  files.active.set("community-plugins.json", bytes("old-enabled"));
  files.staged.set("staged/plugins/p/main.js", bytes("new-code"));
  files.staged.set("staged/community-plugins.json", bytes("new-enabled"));
  return files;
}

function applicator(files: MemoryConfigFiles, state: MemoryConfigState, rebuiltHash: string): SafeConfigBatchApplicator {
  return new SafeConfigBatchApplicator(files, state, {
    snapshotRef: (plan, path) => `recovery/${plan.id}/snapshot/${path}`,
    displacedBeforeRef: (plan, path) => `recovery/${plan.id}/before/${path}`,
    displacedAfterRef: (plan, path) => `recovery/${plan.id}/after/${path}`,
    verifyStaged: async (target) => {
      const value = files.staged.get(target.stagedRef);
      if (!value || hashBytes(value) !== target.hash || value.byteLength !== target.size) throw new Error("stage mismatch");
    },
    rebuildCurrentTreeHash: async () => rebuiltHash,
  });
}

function confirmation(plan: ConfigBatchPlan) {
  return {
    planHash: configBatchPlanHash(plan),
    acceptPluginCode: true,
    acceptSensitiveData: true,
    acceptLoadedPluginChanges: true,
    acceptNewPlugins: true,
  };
}
function observation(value: Uint8Array | undefined): LocalFileObservation { return value ? { kind: "present", hash: hashBytes(value), size: value.byteLength } : { kind: "absent" }; }
function bytes(value: string): Uint8Array { return new TextEncoder().encode(value); }
function text(value: Uint8Array): string { return new TextDecoder().decode(value); }

function ancestors(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}
function hash(value: string): string { return hashBytes(bytes(value)); }
function hashBytes(value: Uint8Array): string { return sha256Hex(value); }
