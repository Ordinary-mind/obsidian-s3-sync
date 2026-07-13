import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../protocol/hash";
import {
  SafeLocalApplicator,
  consumeOwnApplyEvent,
  orderShapeTransformPlans,
  type ApplyGuardState,
  type BoundApplyPlan,
  type SafeApplyJournal,
  type SafeApplyStateStore,
} from "../../core/safe-apply";
import type { LocalFileAdapter, LocalFileObservation } from "../../core/local-file";
import type { RecoveryRecord } from "../../core/recovery-record";

class MemoryLocalFiles implements LocalFileAdapter {
  readonly capabilities = { platform: "linux", domain: "vault", renameToRecovery: true, noClobberInstall: true, recoveryObservation: true, eventsObservable: true } as const;
  readonly active = new Map<string, Uint8Array>();
  readonly staged = new Map<string, Uint8Array>();
  readonly recovery = new Map<string, Uint8Array>();
  step?: () => void;
  mutateRecoveryAfterFirstRead = false;
  recoveryReads = 0;
  reappearBeforeInstall?: Uint8Array;

  async observe(path: string): Promise<LocalFileObservation> {
    this.step?.();
    return observation(this.active.get(path));
  }
  async observeRecovery(ref: string): Promise<LocalFileObservation> {
    this.step?.();
    this.recoveryReads += 1;
    if (this.mutateRecoveryAfterFirstRead && this.recoveryReads === 2) this.recovery.set(ref, bytes("old-edited"));
    return observation(this.recovery.get(ref));
  }
  async moveToRecovery(path: string, ref: string): Promise<void> {
    this.step?.();
    const value = this.active.get(path);
    if (!value || this.recovery.has(ref)) throw new Error("cannot rename");
    this.active.delete(path);
    this.recovery.set(ref, value);
  }
  async installStagedNoClobber(ref: string, path: string): Promise<boolean> {
    this.step?.();
    if (this.reappearBeforeInstall) this.active.set(path, this.reappearBeforeInstall);
    if (this.active.has(path)) return false;
    const value = this.staged.get(ref);
    if (!value) throw new Error("missing staged content");
    this.active.set(path, new Uint8Array(value));
    return true;
  }
  async restoreRecoveryNoClobber(ref: string, path: string): Promise<boolean> {
    if (this.active.has(path)) return false;
    const value = this.recovery.get(ref);
    if (!value) return false;
    this.active.set(path, new Uint8Array(value));
    return true;
  }
  async materializeConservativeCandidate(ref: string, candidateRef: string): Promise<void> {
    const value = this.staged.get(ref);
    if (!value) throw new Error("missing staged content");
    this.recovery.set(candidateRef, new Uint8Array(value));
  }
}

class MemoryApplyState implements SafeApplyStateStore {
  guardValue: ApplyGuardState;
  journals: SafeApplyJournal[] = [];
  recoveries: RecoveryRecord[] = [];
  frozen: LocalFileObservation[] = [];
  accounted = 0;
  step?: () => void;
  mutateGuardAfterJournalState?: SafeApplyJournal["state"];

  constructor(plan: BoundApplyPlan) {
    this.guardValue = { repositoryFingerprint: plan.repositoryFingerprint, observedHeads: [...plan.targetHeads], projectionGeneration: plan.projectionGeneration, dirtyGeneration: plan.dirtyGeneration, hasDirtyIntent: false, hasLocalConcurrentRecord: false };
  }
  async guard(): Promise<ApplyGuardState> { this.step?.(); return { ...this.guardValue, observedHeads: [...this.guardValue.observedHeads] }; }
  async persistJournal(journal: SafeApplyJournal): Promise<void> {
    this.step?.();
    this.journals.push(structuredClone(journal));
    if (journal.state === this.mutateGuardAfterJournalState) this.guardValue.hasDirtyIntent = true;
  }
  async persistRecovery(record: RecoveryRecord): Promise<void> { this.step?.(); this.recoveries.push(structuredClone(record)); }
  async freezeLocalChange(_path: string, observed: LocalFileObservation): Promise<void> { this.step?.(); this.frozen.push(observed); }
  async accountProjection(): Promise<void> { this.step?.(); this.accounted += 1; }
}

describe("safe local applicator", () => {
  it("moves the exact before-image to recovery, installs no-clobber, verifies, and only then accounts", async () => {
    const plan = putPlan();
    const files = seededFiles();
    const state = new MemoryApplyState(plan);
    const result = await applicator(files, state).apply(plan);
    expect(result.status).toBe("accounted");
    expect(text(files.active.get(plan.path)!)).toBe("remote");
    expect(text(files.recovery.get("recovery/op")!)).toBe("old");
    expect(state.journals.map((journal) => journal.state)).toEqual(["prepared", "recovery-moved", "installed", "verified", "accounted"]);
    expect(state.accounted).toBe(1);
  });

  it("never overwrites a path that reappears before no-clobber install", async () => {
    const plan = putPlan();
    const files = seededFiles();
    files.reappearBeforeInstall = bytes("concurrent");
    const state = new MemoryApplyState(plan);
    const result = await applicator(files, state).apply(plan);
    expect(result.status).toBe("local-change-frozen");
    expect(text(files.active.get(plan.path)!)).toBe("concurrent");
    expect(text(files.recovery.get("recovery/op")!)).toBe("old");
    expect(state.accounted).toBe(0);
  });

  it("records old-handle writes in recovery without confusing the formal after-image", async () => {
    const plan = putPlan();
    const files = seededFiles();
    files.mutateRecoveryAfterFirstRead = true;
    const state = new MemoryApplyState(plan);
    const result = await applicator(files, state).apply(plan);
    expect(result.status).toBe("accounted");
    expect(state.recoveries.at(-1)?.postCaptureEdit).toBe(true);
    expect(text(files.active.get(plan.path)!)).toBe("remote");
    expect(text(files.recovery.get("recovery/op")!)).toBe("old-edited");
  });

  it("refuses projection accounting if an editor change arrives after install", async () => {
    const plan = putPlan();
    const files = seededFiles();
    const state = new MemoryApplyState(plan);
    state.mutateGuardAfterJournalState = "installed";
    const result = await applicator(files, state).apply(plan);
    expect(result.status).toBe("recovery-required");
    expect(state.accounted).toBe(0);
    expect(text(files.active.get(plan.path)!)).toBe("remote");
    expect(text(files.recovery.get("recovery/op")!)).toBe("old");
  });

  it("uses conservative candidate materialization when the platform cannot prove preservation", async () => {
    const plan = putPlan();
    const files = seededFiles();
    Object.assign(files.capabilities, { noClobberInstall: false });
    const state = new MemoryApplyState(plan);
    const result = await applicator(files, state).apply(plan);
    expect(result).toMatchObject({ status: "conservative-candidate", candidateRef: "candidate/op" });
    expect(text(files.active.get(plan.path)!)).toBe("old");
    expect(text(files.recovery.get("candidate/op")!)).toBe("remote");
  });

  it("resumes safely after every injected I/O or state boundary", async () => {
    for (let crashAt = 1; crashAt <= 24; crashAt += 1) {
      const plan = putPlan();
      const files = seededFiles();
      const state = new MemoryApplyState(plan);
      let step = 0;
      let crashed = false;
      const inject = () => { step += 1; if (step === crashAt) { crashed = true; throw new Error("crash"); } };
      files.step = inject;
      state.step = inject;
      const first = applicator(files, state);
      try { await first.apply(plan); } catch (error) { expect((error as Error).message).toBe("crash"); }
      files.step = undefined;
      state.step = undefined;
      if (crashed) {
        const latest = state.journals.at(-1);
        const result = latest ? await applicator(files, state).resume(latest) : await applicator(files, state).apply(plan);
        expect(["accounted", "recovery-required", "local-change-frozen"]).toContain(result.status);
      }
      const oldReachable = [...files.active.values(), ...files.recovery.values()].some((value) => text(value) === "old");
      expect(oldReachable, `old bytes lost at boundary ${crashAt}`).toBe(true);
      expect(files.staged.has("staged/remote"), `remote staged bytes lost at boundary ${crashAt}`).toBe(true);
    }
  });

  it("consumes only the exact expected apply event once and orders shape changes safely", () => {
    const expectation = { operationId: "op", path: "foo", target: { kind: "present" as const, hash: hash("remote") }, consumed: false };
    const wrong = consumeOwnApplyEvent(expectation, { path: "foo", observation: { kind: "present", hash: hash("edit"), size: 4 } });
    expect(wrong.ownEvent).toBe(false);
    const own = consumeOwnApplyEvent(expectation, { path: "foo", observation: { kind: "present", hash: hash("remote"), size: 6 } });
    expect(own.ownEvent).toBe(true);
    expect(consumeOwnApplyEvent(own.expectation, { path: "foo", observation: { kind: "present", hash: hash("remote"), size: 6 } }).ownEvent).toBe(false);

    const base = putPlan();
    const ordered = orderShapeTransformPlans([
      { ...base, path: "foo/bar/baz", target: { kind: "delete" } },
      { ...base, path: "foo", target: { kind: "delete" } },
      { ...base, path: "new/deep", target: base.target },
      { ...base, path: "new", target: base.target },
    ]);
    expect(ordered.map((plan) => plan.path)).toEqual(["foo/bar/baz", "foo", "new", "new/deep"]);
  });
});

function applicator(files: MemoryLocalFiles, state: MemoryApplyState): SafeLocalApplicator {
  return new SafeLocalApplicator(files, state, {
    now: () => 1,
    recoveryRef: (plan) => `recovery/${plan.operationId}`,
    conservativeCandidateRef: (plan) => `candidate/${plan.operationId}`,
    verifyStaged: async (target) => {
      const value = files.staged.get(target.stagedRef);
      if (!value || hashBytes(value) !== target.hash || value.byteLength !== target.size) throw new Error("staged target mismatch");
    },
  });
}

function putPlan(): BoundApplyPlan {
  return {
    operationId: "op",
    path: "notes/a.md",
    repositoryFingerprint: "fingerprint",
    targetHeads: ["remote"],
    target: { kind: "put", hash: hash("remote"), size: 6, stagedRef: "staged/remote" },
    expectedLocal: { kind: "present", hash: hash("old"), size: 3 },
    projectionGeneration: 1,
    dirtyGeneration: 0,
  };
}

function seededFiles(): MemoryLocalFiles {
  const files = new MemoryLocalFiles();
  files.active.set("notes/a.md", bytes("old"));
  files.staged.set("staged/remote", bytes("remote"));
  return files;
}

function observation(value: Uint8Array | undefined): LocalFileObservation {
  return value ? { kind: "present", hash: hashBytes(value), size: value.byteLength } : { kind: "absent" };
}
function bytes(value: string): Uint8Array { return new TextEncoder().encode(value); }
function text(value: Uint8Array): string { return new TextDecoder().decode(value); }
function hash(value: string): string { return hashBytes(bytes(value)); }
function hashBytes(value: Uint8Array): string { return sha256Hex(value); }
