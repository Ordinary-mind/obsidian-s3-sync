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
  readonly log: string[] = [];
  failInstallPath?: string;
  mutateBeforeRollback?: { path: string; bytes: Uint8Array };

  async observe(path: string): Promise<LocalFileObservation> { return observation(this.active.get(path)); }
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
    if (this.active.has(path)) return false;
    const value = this.staged.get(ref); if (!value) throw new Error("missing stage");
    this.active.set(path, new Uint8Array(value)); return true;
  }
  async restoreRecoveryNoClobber(ref: string, path: string): Promise<boolean> {
    this.log.push(`restore:${path}`);
    if (this.active.has(path)) return false;
    const value = this.recovery.get(ref); if (!value) return false;
    this.active.set(path, new Uint8Array(value)); return true;
  }
  async materializeConservativeCandidate(): Promise<void> { throw new Error("unused"); }
  async removeEmptyDirectoryNoFollow(): Promise<"absent"> { return "absent"; }
}

class MemoryConfigState implements ConfigBatchStateStore {
  guardValue: ConfigBatchGuard;
  journals: ConfigBatchJournal[] = [];
  accounted = 0;
  dirty = 0;
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
  async markConfigDirtyIntent() { this.dirty += 1; }
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
    const result = await applicator(files, state, "c".repeat(64)).apply(plan, confirmation(plan));
    expect(result.status).toBe("rolled-back");
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

  it("orders deep deletes before shallow deletes and shallow puts before deep puts", () => {
    const base = operation("a", "x", "y");
    const ordered = orderConfigOperations([
      { ...base, path: "x", target: { kind: "delete" } },
      { ...base, path: "x/y", target: { kind: "delete" } },
      { ...base, path: "z/y", target: base.target },
      { ...base, path: "z", target: base.target },
    ]);
    expect(ordered.map((item) => item.path)).toEqual(["x/y", "x", "z", "z/y"]);
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
    projectedTreeHash: "a".repeat(64),
    targetTreeHash: "b".repeat(64),
    operations,
    diff: [{ path: "plugins/p/main.js", kind: "modify", codeChange: true, sensitive: false }],
  };
}

function operation(path: string, before: string, after: string): ConfigBatchOperation {
  return {
    path,
    expected: { kind: "present", hash: hash(before), size: bytes(before).byteLength },
    target: { kind: "put", hash: hash(after), size: bytes(after).byteLength, stagedRef: `staged/${path}` },
  };
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

function confirmation(plan: ConfigBatchPlan) { return { planHash: configBatchPlanHash(plan), acceptPluginCode: true, acceptSensitiveData: true, acceptLoadedPluginChanges: true }; }
function observation(value: Uint8Array | undefined): LocalFileObservation { return value ? { kind: "present", hash: hashBytes(value), size: value.byteLength } : { kind: "absent" }; }
function bytes(value: string): Uint8Array { return new TextEncoder().encode(value); }
function text(value: Uint8Array): string { return new TextDecoder().decode(value); }
function hash(value: string): string { return hashBytes(bytes(value)); }
function hashBytes(value: Uint8Array): string { return sha256Hex(value); }
