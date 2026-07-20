import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../protocol/hash";
import {
  SafeShapeTransformApplicator,
  SafeLocalApplicator,
  consumeOwnApplyEvent,
  orderShapeTransformPlans,
  rebindSafeApplyJournal,
  type ApplyGuardState,
  type BoundApplyPlan,
  type SafeApplyJournal,
  type SafeApplyStateStore,
  type ShapeTransformJournal,
  type ShapeTransformStateStore,
  type ApplyPlanExecutor,
} from "../../core/safe-apply";
import type { LocalFileAdapter, LocalFileObservation } from "../../core/local-file";
import type { RecoveryRecord } from "../../core/recovery-record";

class MemoryLocalFiles implements LocalFileAdapter {
  readonly capabilities = {
    platform: "linux", domain: "vault", renameToRecovery: true, noClobberInstall: true,
    recoveryObservation: true, eventsObservable: true, accessMethod: "node-fs", renameAtomicity: "link-unlink",
    overwritePolicy: "no-clobber", occupiedFileBehavior: "preserve-and-error",
  } as const;
  readonly active = new Map<string, Uint8Array>();
  readonly staged = new Map<string, Uint8Array>();
  readonly recovery = new Map<string, Uint8Array>();
  readonly directories = new Set<string>();
  readonly unknownPaths = new Set<string>();
  step?: () => void;
  mutateRecoveryAfterFirstRead = false;
  recoveryReads = 0;
  reappearBeforeInstall?: Uint8Array;
  reappearAfterRecoveryRead?: Uint8Array;
  replaceAfterInstall?: Uint8Array;
  failMoveOnce?: Error;
  failInstallOnce?: Error;
  failVerifyOnce?: Error;

  async observe(path: string): Promise<LocalFileObservation> {
    this.step?.();
    if (this.unknownPaths.has(path) || this.directories.has(path)) return { kind: "unknown", reason: "injected unknown or directory" };
    if (this.replaceAfterInstall && this.active.has(path)) {
      this.active.set(path, this.replaceAfterInstall);
      this.replaceAfterInstall = undefined;
    }
    return observation(this.active.get(path));
  }
  async observeRecovery(ref: string): Promise<LocalFileObservation> {
    this.step?.();
    this.recoveryReads += 1;
    if (this.mutateRecoveryAfterFirstRead && this.recoveryReads === 2) this.recovery.set(ref, bytes("old-edited"));
    if (this.reappearAfterRecoveryRead && this.recoveryReads === 1) this.active.set("notes/a.md", this.reappearAfterRecoveryRead);
    return observation(this.recovery.get(ref));
  }
  async moveToRecovery(path: string, ref: string): Promise<void> {
    this.step?.();
    if (this.failMoveOnce) { const error = this.failMoveOnce; this.failMoveOnce = undefined; throw error; }
    const value = this.active.get(path);
    if (!value || this.recovery.has(ref)) throw new Error("cannot rename");
    this.active.delete(path);
    this.recovery.set(ref, value);
  }
  async installStagedNoClobber(ref: string, path: string): Promise<boolean> {
    this.step?.();
    if (this.failInstallOnce) { const error = this.failInstallOnce; this.failInstallOnce = undefined; throw error; }
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
  async removeEmptyDirectoryNoFollow(path: string): Promise<"removed" | "absent" | "not-empty"> {
    if (!this.directories.has(path)) return "absent";
    const prefix = `${path}/`;
    if ([...this.active.keys()].some((candidate) => candidate.startsWith(prefix))
      || [...this.directories].some((candidate) => candidate.startsWith(prefix))) return "not-empty";
    this.directories.delete(path);
    return "removed";
  }
}

class MemoryApplyState implements SafeApplyStateStore {
  guardValue: ApplyGuardState;
  journals: SafeApplyJournal[] = [];
  recoveries: RecoveryRecord[] = [];
  frozen: LocalFileObservation[] = [];
  frozenBases: string[][] = [];
  accounted = 0;
  step?: () => void;
  mutateGuardAfterJournalState?: SafeApplyJournal["state"];
  mutateHeadsAfterJournalState?: SafeApplyJournal["state"];
  afterPersistJournal?: (journal: SafeApplyJournal) => void;

  constructor(plan: BoundApplyPlan) {
    this.guardValue = {
      repositoryFingerprint: plan.repositoryFingerprint,
      observedHeads: [...plan.targetHeads],
      projectedHeads: [...plan.projectedHeads],
      projectedValue: { ...plan.expectedLocal },
      projectionGeneration: plan.projectionGeneration,
      dirtyGeneration: plan.dirtyGeneration,
      hasDirtyIntent: false,
      hasDirtyRecord: false,
      hasLocalConcurrentRecord: false,
    };
  }
  async guard(): Promise<ApplyGuardState> { this.step?.(); return { ...this.guardValue, observedHeads: [...this.guardValue.observedHeads] }; }
  async persistJournal(journal: SafeApplyJournal): Promise<void> {
    this.step?.();
    this.journals.push(structuredClone(journal));
    if (journal.state === this.mutateGuardAfterJournalState) this.guardValue.hasDirtyIntent = true;
    if (journal.state === this.mutateHeadsAfterJournalState) this.guardValue.observedHeads = ["new-remote-head"];
    this.afterPersistJournal?.(journal);
  }
  async persistRecovery(record: RecoveryRecord): Promise<void> { this.step?.(); this.recoveries.push(structuredClone(record)); }
  async freezeLocalChange(_path: string, observed: LocalFileObservation, basisHeads: readonly string[]): Promise<void> {
    this.step?.(); this.frozen.push(observed); this.frozenBases.push([...basisHeads]);
  }
  async accountProjection(_plan: BoundApplyPlan, _after: Exclude<LocalFileObservation, { kind: "unknown" }>, journal: SafeApplyJournal): Promise<void> {
    this.step?.(); this.accounted += 1; this.journals.push(structuredClone(journal));
  }
}

class ShapeExecutor implements ApplyPlanExecutor {
  readonly journals = new Map<string, SafeApplyJournal>();
  constructor(private readonly files: MemoryLocalFiles) {}

  async apply(plan: BoundApplyPlan) {
    if (plan.target.kind === "delete") {
      const value = this.files.active.get(plan.path);
      if (!value) return { status: "pending" as const };
      this.files.active.delete(plan.path);
      this.files.recovery.set(`recovery/${plan.operationId}`, value);
    } else {
      if (this.files.active.has(plan.path) || this.files.directories.has(plan.path)) return { status: "local-change-frozen" as const };
      const value = this.files.staged.get(plan.target.stagedRef);
      if (!value) return { status: "pending" as const };
      const segments = plan.path.split("/");
      for (let index = 1; index < segments.length; index += 1) this.files.directories.add(segments.slice(0, index).join("/"));
      this.files.active.set(plan.path, new Uint8Array(value));
    }
    const after = observation(this.files.active.get(plan.path));
    const journal: SafeApplyJournal = { ...structuredClone(plan), state: "accounted", verifiedAfter: after.kind === "unknown" ? undefined : after };
    this.journals.set(plan.operationId, journal);
    return { status: "accounted" as const, journal };
  }

  async resume(journal: SafeApplyJournal) { return { status: "accounted" as const, journal }; }
}

class ShapeState implements ShapeTransformStateStore {
  readonly groups: ShapeTransformJournal[] = [];
  persistCount = 0;
  crashAt?: number;
  constructor(private readonly executor: ShapeExecutor) {}
  async persistGroupJournal(journal: ShapeTransformJournal): Promise<void> {
    this.persistCount += 1;
    if (this.persistCount === this.crashAt) throw new Error("shape crash");
    this.groups.push(structuredClone(journal));
  }
  async loadApplyJournal(operationId: string): Promise<SafeApplyJournal | undefined> {
    return this.executor.journals.get(operationId);
  }
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

  it("separates the Vault recovery path from the repository-relative durable reference", async () => {
    const plan = putPlan();
    const files = seededFiles();
    const state = new MemoryApplyState(plan);
    const physicalRef = `.obsidian/.obsidian-s3-sync-local/repository/recovery/${plan.operationId}`;

    const result = await applicator(files, state, {
      recoveryRef: () => physicalRef,
      recoveryContentRef: () => `recovery/${plan.operationId}`,
    }).apply(plan);

    expect(result.status).toBe("accounted");
    if (result.status !== "accounted") throw new Error("expected accounted result");
    expect(text(files.recovery.get(physicalRef)!)).toBe("old");
    expect(state.recoveries.at(-1)?.contentRef).toBe(`recovery/${plan.operationId}`);
    expect(result.journal.recoveryRef).toBe(physicalRef);
    expect(result.journal.recoveryRecord?.contentRef).toBe(`recovery/${plan.operationId}`);
  });

  it("rebinds an unfinished apply to the currently verified remote choice without changing its before-image", () => {
    const plan = putPlan();
    const recoveryMoved: SafeApplyJournal = {
      ...structuredClone(plan),
      state: "recovery-moved",
      recoveryRef: "vault-state/recovery/op",
    };
    const rebound = rebindSafeApplyJournal(recoveryMoved, {
      repositoryFingerprint: plan.repositoryFingerprint,
      targetHeads: ["new-remote"],
      projectedHeads: ["new-projected"],
      target: { kind: "put", hash: hash("new"), size: 3, stagedRef: "staged/new" },
      projectionGeneration: 2,
      dirtyGeneration: 3,
    });

    expect(rebound).toMatchObject({
      operationId: plan.operationId,
      expectedLocal: plan.expectedLocal,
      recoveryRef: "vault-state/recovery/op",
      targetHeads: ["new-remote"],
      projectedHeads: ["new-projected"],
      target: { hash: hash("new"), stagedRef: "staged/new" },
      projectionGeneration: 2,
      dirtyGeneration: 3,
    });
    expect(() => rebindSafeApplyJournal({ ...recoveryMoved, state: "installed" }, {
      repositoryFingerprint: plan.repositoryFingerprint,
      targetHeads: ["new-remote"],
      projectedHeads: ["new-projected"],
      target: { kind: "delete" },
      projectionGeneration: 2,
      dirtyGeneration: 3,
    })).toThrow("cannot change target");
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

  it("finishes a recovery-required apply when the selected target is already installed and reverified", async () => {
    const plan = putPlan();
    const files = seededFiles();
    const state = new MemoryApplyState(plan);
    state.mutateGuardAfterJournalState = "installed";
    const interrupted = await applicator(files, state).apply(plan);
    expect(interrupted.status).toBe("recovery-required");
    if (interrupted.status !== "recovery-required" || !interrupted.journal) {
      throw new Error("expected interrupted journal");
    }

    state.guardValue.hasDirtyIntent = false;
    state.mutateGuardAfterJournalState = undefined;
    const resumed = await applicator(files, state).resume(interrupted.journal);

    expect(resumed.status).toBe("accounted");
    expect(state.accounted).toBe(1);
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

  it("binds the destructive before-image to persisted projection and freezes delayed local divergence on projectedHeads", async () => {
    const plan = { ...putPlan(), expectedLocal: { kind: "present" as const, hash: hash("local"), size: 5 } };
    const files = seededFiles();
    files.active.set(plan.path, bytes("local"));
    const state = new MemoryApplyState(putPlan());
    const result = await applicator(files, state).apply(plan);
    expect(result.status).toBe("local-change-frozen");
    expect(state.frozenBases).toEqual([["projected"]]);
    expect(text(files.active.get(plan.path)!)).toBe("local");
    expect(files.recovery.size).toBe(0);
  });

  it("adopts an already-identical remote target without a destructive write", async () => {
    const plan = putPlan();
    const files = seededFiles();
    files.active.set(plan.path, bytes("remote"));
    const state = new MemoryApplyState(plan);
    const result = await applicator(files, state).apply(plan);
    expect(result.status).toBe("adopted-without-write");
    expect(files.recovery.size).toBe(0);
    expect(state.accounted).toBe(1);
    const persisted: SafeApplyJournal = { ...structuredClone(plan), state: "verified", writeMode: "none", verifiedAfter: observation(files.active.get(plan.path)) as Exclude<LocalFileObservation, { kind: "unknown" }> };
    const resumed = await applicator(files, new MemoryApplyState(plan)).resume(persisted);
    expect(resumed.status).toBe("accounted");
  });

  it("keeps both sides reachable across delete races and recoverable I/O failures", async () => {
    const deletion = { ...putPlan(), target: { kind: "delete" as const } };
    const racedFiles = seededFiles();
    racedFiles.reappearAfterRecoveryRead = bytes("concurrent");
    const racedState = new MemoryApplyState(deletion);
    const raced = await applicator(racedFiles, racedState).apply(deletion);
    expect(raced.status).toBe("recovery-required");
    expect(text(racedFiles.active.get(deletion.path)!)).toBe("concurrent");
    expect(text(racedFiles.recovery.get("recovery/op")!)).toBe("old");

    for (const failure of ["move", "install"] as const) {
      const plan = putPlan();
      const files = seededFiles();
      const state = new MemoryApplyState(plan);
      if (failure === "move") files.failMoveOnce = new Error("injected move failure");
      else files.failInstallOnce = new Error("injected install failure");
      await expect(applicator(files, state).apply(plan)).rejects.toThrow("injected");
      expect([...files.active.values(), ...files.recovery.values()].some((value) => text(value) === "old")).toBe(true);
      const latest = state.journals.at(-1)!;
      const resumed = await applicator(files, state).resume(latest);
      expect(resumed.status).toBe("accounted");
    }
  });

  it("verifies the moved before-image before resuming a delete whose latest Journal is still prepared", async () => {
    const plan = { ...putPlan(), target: { kind: "delete" as const } };
    const files = seededFiles();
    await files.moveToRecovery(plan.path, "recovery/op");
    const state = new MemoryApplyState(plan);
    const prepared: SafeApplyJournal = { ...structuredClone(plan), state: "prepared" };
    const result = await applicator(files, state).resume(prepared);
    expect(result.status).toBe("accounted");
    expect(state.recoveries.length).toBeGreaterThanOrEqual(1);
    expect(text(files.recovery.get("recovery/op")!)).toBe("old");
  });

  it("recovers from disk-full, permission, occupied-file, and parent-creation failures", async () => {
    const scenarios = [
      { code: "ENOSPC", point: "verify" },
      { code: "EACCES", point: "move" },
      { code: "EPERM", point: "move" },
      { code: "ENOENT", point: "install" },
    ] as const;
    for (const scenario of scenarios) {
      const plan = putPlan();
      const files = seededFiles();
      const state = new MemoryApplyState(plan);
      const error = Object.assign(new Error(`injected ${scenario.code}`), { code: scenario.code });
      if (scenario.point === "verify") files.failVerifyOnce = error;
      if (scenario.point === "move") files.failMoveOnce = error;
      if (scenario.point === "install") files.failInstallOnce = error;
      await expect(applicator(files, state).apply(plan)).rejects.toMatchObject({ code: scenario.code });
      expect([...files.active.values(), ...files.recovery.values()].some((value) => text(value) === "old")).toBe(true);
      const latest = state.journals.at(-1);
      const resumed = latest ? await applicator(files, state).resume(latest) : await applicator(files, state).apply(plan);
      expect(resumed.status).toBe("accounted");
    }
  });

  it("resumes safely after every injected I/O or state boundary", async () => {
    const countedPlan = putPlan();
    const countedFiles = seededFiles();
    const countedState = new MemoryApplyState(countedPlan);
    let boundaryCount = 0;
    const count = () => { boundaryCount += 1; };
    countedFiles.step = count;
    countedState.step = count;
    await applicator(countedFiles, countedState).apply(countedPlan);
    expect(boundaryCount).toBeGreaterThan(8);

    for (let crashAt = 1; crashAt <= boundaryCount; crashAt += 1) {
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

  it("blocks editor, remote-head, and external-write races at every persisted apply phase", async () => {
    for (const source of ["editor", "remote-head", "external"] as const) {
      for (const phase of ["prepared", "recovery-moved", "installed", "verified"] as const) {
        const plan = putPlan();
        const files = seededFiles();
        const state = new MemoryApplyState(plan);
        if (source === "editor") state.mutateGuardAfterJournalState = phase;
        if (source === "remote-head") state.mutateHeadsAfterJournalState = phase;
        if (source === "external") {
          state.afterPersistJournal = (journal) => {
            if (journal.state === phase) files.active.set(plan.path, bytes(`external-${phase}`));
          };
        }
        const result = await applicator(files, state).apply(plan);
        expect(["stale-plan", "local-change-frozen", "recovery-required"]).toContain(result.status);
        expect(state.accounted).toBe(0);
        const reachable = [...files.active.values(), ...files.recovery.values()].map(text);
        expect(reachable.some((value) => value === "old" || value === `external-${phase}`)).toBe(true);
      }
    }
  });

  it("consumes only the exact expected apply event once and orders shape changes safely", () => {
    const expectation = { operationId: "op", path: "foo", target: { kind: "present" as const, hash: hash("remote") }, consumed: false };
    const wrong = consumeOwnApplyEvent(expectation, { path: "foo", observation: { kind: "present", hash: hash("edit"), size: 4 } });
    expect(wrong.ownEvent).toBe(false);
    expect(consumeOwnApplyEvent(expectation, { path: "foo", observation: { kind: "present", hash: hash("remote"), size: 6 } }).ownEvent).toBe(false);
    const own = consumeOwnApplyEvent(expectation, { operationId: "op", path: "foo", observation: { kind: "present", hash: hash("remote"), size: 6 } });
    expect(own.ownEvent).toBe(true);
    expect(consumeOwnApplyEvent(own.expectation, { operationId: "op", path: "foo", observation: { kind: "present", hash: hash("remote"), size: 6 } }).ownEvent).toBe(false);

    const base = putPlan();
    const ordered = orderShapeTransformPlans([
      { ...base, path: "foo/bar/baz", target: { kind: "delete" } },
      { ...base, path: "foo", target: { kind: "delete" } },
      { ...base, path: "new/deep", target: base.target },
      { ...base, path: "new", target: base.target },
    ]);
    expect(ordered.map((plan) => plan.path)).toEqual(["foo/bar/baz", "foo", "new", "new/deep"]);
  });

  it("applies both file-directory shape directions as one resumable group and stops on unplanned children", async () => {
    const fileToDirectory = new MemoryLocalFiles();
    fileToDirectory.active.set("foo", bytes("old-file"));
    fileToDirectory.staged.set("staged/foo-bar", bytes("remote-child"));
    const firstPlans = [
      shapeDeletePlan("delete-foo", "foo", "old-file"),
      shapePutPlan("put-child", "foo/bar", "staged/foo-bar", "remote-child"),
    ];
    const firstExecutor = new ShapeExecutor(fileToDirectory);
    const firstResult = await new SafeShapeTransformApplicator(fileToDirectory, firstExecutor, new ShapeState(firstExecutor)).apply(firstPlans);
    expect(firstResult.status).toBe("accounted");
    expect(text(fileToDirectory.active.get("foo/bar")!)).toBe("remote-child");
    expect(text(fileToDirectory.recovery.get("recovery/delete-foo")!)).toBe("old-file");

    const directoryToFile = new MemoryLocalFiles();
    directoryToFile.directories.add("foo");
    directoryToFile.active.set("foo/bar", bytes("old-child"));
    directoryToFile.staged.set("staged/foo", bytes("remote-file"));
    const secondPlans = [
      shapeDeletePlan("delete-child", "foo/bar", "old-child"),
      shapePutPlan("put-foo", "foo", "staged/foo", "remote-file"),
    ];
    const secondExecutor = new ShapeExecutor(directoryToFile);
    const secondState = new ShapeState(secondExecutor);
    const secondResult = await new SafeShapeTransformApplicator(directoryToFile, secondExecutor, secondState).apply(secondPlans);
    expect(secondResult.status).toBe("accounted");
    expect(text(directoryToFile.active.get("foo")!)).toBe("remote-file");
    expect(text(directoryToFile.recovery.get("recovery/delete-child")!)).toBe("old-child");

    const blocked = new MemoryLocalFiles();
    blocked.directories.add("foo");
    blocked.active.set("foo/bar", bytes("planned-child"));
    blocked.active.set("foo/user", bytes("unplanned-child"));
    blocked.staged.set("staged/foo", bytes("remote-file"));
    const blockedExecutor = new ShapeExecutor(blocked);
    const blockedResult = await new SafeShapeTransformApplicator(blocked, blockedExecutor, new ShapeState(blockedExecutor)).apply([
      shapeDeletePlan("delete-planned", "foo/bar", "planned-child"),
      shapePutPlan("put-blocked", "foo", "staged/foo", "remote-file"),
    ]);
    expect(blockedResult).toMatchObject({ status: "pending", path: "foo" });
    expect(text(blocked.active.get("foo/user")!)).toBe("unplanned-child");
    expect(text(blocked.recovery.get("recovery/delete-planned")!)).toBe("planned-child");
  });

  it("resumes a shape transform after every group Journal persistence boundary", async () => {
    for (let crashAt = 1; crashAt <= 6; crashAt += 1) {
      const files = new MemoryLocalFiles();
      files.directories.add("foo");
      files.active.set("foo/bar", bytes("old-child"));
      files.staged.set("staged/foo", bytes("remote-file"));
      const plans = [
        shapeDeletePlan("delete-child", "foo/bar", "old-child"),
        shapePutPlan("put-foo", "foo", "staged/foo", "remote-file"),
      ];
      const executor = new ShapeExecutor(files);
      const state = new ShapeState(executor);
      state.crashAt = crashAt;
      const engine = new SafeShapeTransformApplicator(files, executor, state);
      await expect(engine.apply(plans)).rejects.toThrow("shape crash");
      state.crashAt = undefined;
      const result = await engine.apply(plans, state.groups.at(-1));
      expect(result.status).toBe("accounted");
      expect(text(files.active.get("foo")!)).toBe("remote-file");
      expect(text(files.recovery.get("recovery/delete-child")!)).toBe("old-child");
    }
  });
});

function applicator(
  files: MemoryLocalFiles,
  state: MemoryApplyState,
  references: Partial<Pick<ConstructorParameters<typeof SafeLocalApplicator>[2], "recoveryRef" | "recoveryContentRef">> = {},
): SafeLocalApplicator {
  return new SafeLocalApplicator(files, state, {
    now: () => 1,
    recoveryRef: references.recoveryRef ?? ((plan) => `recovery/${plan.operationId}`),
    recoveryContentRef: references.recoveryContentRef ?? ((plan) => `recovery/${plan.operationId}`),
    conservativeCandidateRef: (plan) => `candidate/${plan.operationId}`,
    verifyStaged: async (target) => {
      files.step?.();
      if (files.failVerifyOnce) { const error = files.failVerifyOnce; files.failVerifyOnce = undefined; throw error; }
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
    projectedHeads: ["projected"],
    target: { kind: "put", hash: hash("remote"), size: 6, stagedRef: "staged/remote" },
    expectedLocal: { kind: "present", hash: hash("old"), size: 3 },
    projectionGeneration: 1,
    dirtyGeneration: 0,
  };
}

function shapeDeletePlan(operationId: string, path: string, before: string): BoundApplyPlan {
  return {
    ...putPlan(), operationId, path, groupId: "shape", target: { kind: "delete" },
    expectedLocal: { kind: "present", hash: hash(before), size: bytes(before).byteLength },
  };
}

function shapePutPlan(operationId: string, path: string, stagedRef: string, value: string): BoundApplyPlan {
  return {
    ...putPlan(), operationId, path, groupId: "shape", expectedLocal: { kind: "absent" },
    target: { kind: "put", hash: hash(value), size: bytes(value).byteLength, stagedRef },
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
