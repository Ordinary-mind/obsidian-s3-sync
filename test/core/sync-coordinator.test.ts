import { describe, expect, it } from "vitest";
import {
  InProcessVaultCoordinationLock,
  PathLockManager,
  SyncCoordinator,
  SyncCoordinatorError,
  type CoordinatorClock,
  type CoordinatorRoundContext,
  type CoordinatorSettings,
  type PathOperationResult,
  type PreviewPlan,
  type SyncPipeline,
  type VaultCoordinationLock,
} from "../../core/sync-coordinator";

class FakeClock implements CoordinatorClock {
  time = 100;
  nextId = 1;
  readonly timers = new Map<number, { callback: () => void; delay: number }>();
  now(): number { return this.time; }
  setTimer(callback: () => void, delay: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { callback, delay });
    return id;
  }
  clearTimer(handle: unknown): void { this.timers.delete(handle as number); }
  hasDelay(delay: number): boolean { return [...this.timers.values()].some((timer) => timer.delay === delay); }
  fireDelay(delay: number): void {
    const timer = [...this.timers.entries()].find(([, candidate]) => candidate.delay === delay);
    if (!timer) throw new Error(`no timer with delay ${delay}`);
    this.timers.delete(timer[0]);
    this.time += timer[1].delay;
    timer[1].callback();
  }
}

class FakePipeline implements SyncPipeline {
  readonly calls: string[] = [];
  readonly rounds: Array<{ generation: number; triggers: string[] }> = [];
  readonly hooks = new Map<string, (context: CoordinatorRoundContext) => void | Promise<void>>();
  failure?: { stage: string; error: Error };
  pullGate?: Promise<void>;
  onPull?: () => void;
  previewValid = true;
  readonly preview: PreviewPlan = { id: "preview", repositoryFingerprint: "fingerprint", remoteRevision: "remote", localRevision: "local", decisions: [] };

  recover = async (context: CoordinatorRoundContext) => {
    this.rounds.push({ generation: context.generation, triggers: [...context.triggers] });
    await this.call("recover", context);
  };
  verifyRepository = (context: CoordinatorRoundContext) => this.call("verify", context);
  pull = async (context: CoordinatorRoundContext) => {
    this.onPull?.();
    await this.call("pull", context);
    if (this.pullGate) await abortable(this.pullGate, context.signal);
  };
  persistMerge = (context: CoordinatorRoundContext) => this.call("merge", context);
  applyVault = (context: CoordinatorRoundContext) => this.call("apply", context);
  detectLocalChanges = (context: CoordinatorRoundContext) => this.call("scan", context);
  repull = (context: CoordinatorRoundContext) => this.call("repull", context);
  freezeOutbox = (context: CoordinatorRoundContext) => this.call("freeze", context);
  publishOutbox = (context: CoordinatorRoundContext) => this.call("publish", context);
  verifyPublished = (context: CoordinatorRoundContext) => this.call("verify-published", context);
  async buildPreview(): Promise<PreviewPlan> { this.calls.push("preview"); return this.preview; }
  async revalidatePreview(): Promise<boolean> { this.calls.push("revalidate-preview"); return this.previewValid; }
  async executePreview(): Promise<void> { this.calls.push("execute-preview"); }
  async fullAudit(_context: CoordinatorRoundContext, progress: (completed: number, total: number) => void): Promise<void> {
    this.calls.push("audit");
    progress(1, 2);
    progress(2, 2);
  }

  private async call(stage: string, context: CoordinatorRoundContext): Promise<void> {
    if (context.signal.aborted) throw abortError();
    this.calls.push(stage);
    if (this.failure?.stage === stage) throw this.failure.error;
    await this.hooks.get(stage)?.(context);
  }
}

describe("sync coordinator", () => {
  it("executes the frozen single-round order", async () => {
    const pipeline = new FakePipeline();
    const coordinator = await readyCoordinator(pipeline);
    await coordinator.syncNow();
    expect(pipeline.calls).toEqual(["recover", "verify", "pull", "merge", "apply", "scan", "repull", "freeze", "publish", "verify-published"]);
    expect(coordinator.status()).toMatchObject({ phase: "idle", running: false, generation: 1, pendingTriggers: [] });
    await coordinator.stop();
  });

  it("coalesces triggers raised during a round into one following generation", async () => {
    const pipeline = new FakePipeline();
    let release!: () => void;
    let entered!: () => void;
    const enteredPull = new Promise<void>((resolve) => { entered = resolve; });
    pipeline.pullGate = new Promise<void>((resolve) => { release = resolve; });
    pipeline.onPull = entered;
    const coordinator = await readyCoordinator(pipeline, {
      settings: { polling: true, pollIntervalMs: 1_000_000 },
    });
    const running = coordinator.syncNow();
    await enteredPull;
    const queued = [coordinator.notifyLocalEvent(), coordinator.notifyLocalEvent(), coordinator.notifyPoll(), coordinator.syncNow()];
    release();
    await Promise.all([running, ...queued]);
    expect(pipeline.rounds).toEqual([
      { generation: 1, triggers: ["manual"] },
      { generation: 2, triggers: ["manual", "event", "poll"] },
    ]);
    await coordinator.stop();
  });

  it("puts duplicate Vault instances into read-only mode, including through the process-global default lock", async () => {
    const lock = new InProcessVaultCoordinationLock();
    const first = createCoordinator(new FakePipeline(), { lock, instanceId: "one", vaultId: "shared" });
    const second = createCoordinator(new FakePipeline(), { lock, instanceId: "one", vaultId: "shared" });
    await first.initialize();
    await second.initialize();
    expect(second.status()).toMatchObject({ phase: "read-only", readOnly: true });
    await expect(second.syncNow()).rejects.toThrow("read-only");
    await expect(second.previewNow()).resolves.toMatchObject({ id: "preview" });
    await first.stop();
    await second.stop();

    const globalVaultId = crypto.randomUUID();
    const globalFirst = createCoordinator(new FakePipeline(), { vaultId: globalVaultId, instanceId: "global-one", lock: undefined });
    const globalSecond = createCoordinator(new FakePipeline(), { vaultId: globalVaultId, instanceId: "global-two", lock: undefined });
    await globalFirst.initialize();
    await globalSecond.initialize();
    expect(globalSecond.status().readOnly).toBe(true);
    await globalFirst.stop();
    await globalSecond.stop();
  });

  it("runs startup reconciliation, polling, and low-frequency audits only while enabled", async () => {
    const pipeline = new FakePipeline();
    const clock = new FakeClock();
    const coordinator = createCoordinator(pipeline, {
      clock,
      settings: { startup: true, polling: true, pollIntervalMs: 50, auditIntervalMs: 200 },
    });
    await coordinator.initialize();
    expect(pipeline.rounds).toEqual([{ generation: 1, triggers: ["startup"] }]);
    expect(clock.hasDelay(50)).toBe(true);
    expect(clock.hasDelay(200)).toBe(true);

    clock.fireDelay(50);
    await eventually(() => pipeline.rounds.length === 2);
    expect(pipeline.rounds[1].triggers).toEqual(["poll"]);

    coordinator.setSettings({ startup: false, events: true, polling: false, auditIntervalMs: 200 });
    expect(clock.hasDelay(50)).toBe(false);
    clock.fireDelay(200);
    await eventually(() => pipeline.calls.includes("audit"));
    coordinator.setSettings({ startup: false, events: true, polling: false });
    expect(clock.hasDelay(200)).toBe(false);
    await coordinator.stop();
  });

  it("coalesces offline event, poll, and manual requests before reconnecting", async () => {
    const pipeline = new FakePipeline();
    pipeline.failure = { stage: "pull", error: new SyncCoordinatorError("offline", "network") };
    const coordinator = await readyCoordinator(pipeline, {
      settings: { polling: true, pollIntervalMs: 1_000_000 },
    });
    await Promise.all([
      coordinator.notifyLocalEvent(),
      coordinator.notifyLocalEvent(),
      coordinator.notifyPoll(),
      coordinator.syncNow(),
    ]);
    expect(pipeline.rounds).toEqual([{ generation: 1, triggers: ["manual", "event", "poll"] }]);
    expect(coordinator.status().phase).toBe("waiting-retry");
    pipeline.failure = undefined;
    await coordinator.retryNow();
    expect(pipeline.rounds[1]).toEqual({ generation: 2, triggers: ["manual"] });
    expect(coordinator.status()).toMatchObject({ phase: "idle", retryAttempt: 0 });
    await coordinator.stop();
  });

  it("stops auth retries, backs off retryable remote failures, and does not globally retry path errors", async () => {
    const authPipeline = new FakePipeline();
    authPipeline.failure = { stage: "pull", error: new SyncCoordinatorError("denied", "authentication") };
    const authClock = new FakeClock();
    const auth = await readyCoordinator(authPipeline, { clock: authClock });
    let queuedDuringFailure = false;
    authPipeline.onPull = () => {
      if (queuedDuringFailure) return;
      queuedDuringFailure = true;
      void auth.notifyLocalEvent();
    };
    await auth.syncNow();
    expect(auth.status()).toMatchObject({ autoRetryStopped: true, lastErrorCategory: "authentication", retryAt: undefined });
    expect(authClock.timers.size).toBe(0);
    expect(auth.status().pendingTriggers).toEqual(["event"]);
    expect(authPipeline.rounds).toHaveLength(1);
    authPipeline.failure = undefined;
    await auth.retryNow();
    expect(authPipeline.rounds).toHaveLength(2);
    await auth.stop();

    for (const category of ["network", "rate-limit", "server"] as const) {
      const pipeline = new FakePipeline();
      pipeline.failure = { stage: "pull", error: new SyncCoordinatorError("temporary", category) };
      const clock = new FakeClock();
      const coordinator = await readyCoordinator(pipeline, { clock });
      await coordinator.syncNow();
      expect(coordinator.status()).toMatchObject({ phase: "waiting-retry", retryAttempt: 1, retryAt: 1100 });
      pipeline.failure = undefined;
      clock.fireDelay(1000);
      await eventually(() => coordinator.status().retryAttempt === 0 && !coordinator.status().running);
      expect(pipeline.rounds).toHaveLength(2);
      await coordinator.stop();
    }

    const pathPipeline = new FakePipeline();
    pathPipeline.failure = { stage: "apply", error: new SyncCoordinatorError("occupied", "local-path") };
    const pathClock = new FakeClock();
    const pathCoordinator = await readyCoordinator(pathPipeline, { clock: pathClock });
    await pathCoordinator.syncNow();
    expect(pathCoordinator.status()).toMatchObject({ phase: "idle", autoRetryStopped: false, lastErrorCategory: "local-path", retryAt: undefined });
    expect(pathClock.timers.size).toBe(0);
    await pathCoordinator.stop();
  });

  it("serializes previews and audits with sync, then revalidates immediately before execution", async () => {
    const pipeline = new FakePipeline();
    let release!: () => void;
    let entered!: () => void;
    const enteredPull = new Promise<void>((resolve) => { entered = resolve; });
    pipeline.pullGate = new Promise<void>((resolve) => { release = resolve; });
    pipeline.onPull = entered;
    const coordinator = await readyCoordinator(pipeline);
    const running = coordinator.syncNow();
    await enteredPull;
    const preview = coordinator.previewNow();
    await Promise.resolve();
    expect(pipeline.calls).not.toContain("preview");
    release();
    const plan = await preview;
    await running;

    pipeline.previewValid = false;
    await expect(coordinator.executePreview(plan)).rejects.toThrow("stale");
    expect(pipeline.calls).not.toContain("execute-preview");
    await coordinator.fullAudit();
    expect(coordinator.status().auditProgress).toEqual({ completed: 2, total: 2 });
    await coordinator.stop();
  });

  it("keeps ingested and observed state while one path remains pending across restart", async () => {
    const state = {
      ingestedFrontier: 0,
      observedHeads: new Set<string>(),
      pendingApply: new Set<string>(),
      projectedHeads: new Set<string>(),
    };
    let merged = false;
    let failBlockedPath = true;
    let lastResults: PathOperationResult<void>[] = [];
    const pipeline = new FakePipeline();
    pipeline.hooks.set("merge", () => {
      if (merged) return;
      merged = true;
      state.ingestedFrontier = 1;
      state.observedHeads.add("remote-commit");
      state.pendingApply.add("blocked.md");
      state.pendingApply.add("ready.md");
    });
    pipeline.hooks.set("apply", async (context) => {
      lastResults = await context.paths.runIndependent([...state.pendingApply], async (path) => {
        if (path === "blocked.md" && failBlockedPath) throw new Error("occupied");
        state.pendingApply.delete(path);
        state.projectedHeads.add(path);
      });
    });

    const lock = new InProcessVaultCoordinationLock();
    const first = await readyCoordinator(pipeline, { lock, vaultId: "restart-vault" });
    await first.syncNow();
    expect(lastResults.map((result) => [result.path, result.status])).toEqual([
      ["blocked.md", "rejected"],
      ["ready.md", "fulfilled"],
    ]);
    expect(state).toMatchObject({ ingestedFrontier: 1 });
    expect([...state.observedHeads]).toEqual(["remote-commit"]);
    expect([...state.pendingApply]).toEqual(["blocked.md"]);
    expect([...state.projectedHeads]).toEqual(["ready.md"]);
    await first.stop();

    failBlockedPath = false;
    const restarted = await readyCoordinator(pipeline, { lock, vaultId: "restart-vault", instanceId: "restarted" });
    await restarted.syncNow();
    expect([...state.pendingApply]).toEqual([]);
    expect([...state.projectedHeads].sort()).toEqual(["blocked.md", "ready.md"]);
    expect([...state.observedHeads]).toEqual(["remote-commit"]);
    await restarted.stop();
  });

  it("aborts active requests on stop and refuses new work", async () => {
    const pipeline = new FakePipeline();
    let entered!: () => void;
    const enteredPull = new Promise<void>((resolve) => { entered = resolve; });
    pipeline.pullGate = new Promise<void>(() => undefined);
    pipeline.onPull = entered;
    const clock = new FakeClock();
    const coordinator = await readyCoordinator(pipeline, {
      clock,
      settings: { polling: true, pollIntervalMs: 50, auditIntervalMs: 200 },
    });
    const running = coordinator.syncNow().then(() => "completed", (error: Error) => error.name);
    await enteredPull;
    await coordinator.stop();
    expect(await running).toBe("AbortError");
    expect(coordinator.status()).toMatchObject({ phase: "stopped", running: false, pendingTriggers: [] });
    expect(clock.timers.size).toBe(0);
    await expect(coordinator.syncNow()).rejects.toThrow("stopped");
  });
});

describe("path lock manager", () => {
  it("serializes the same path while allowing unrelated paths to progress", async () => {
    const locks = new PathLockManager();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = locks.runExclusive("a", async () => { order.push("a1-start"); await gate; order.push("a1-end"); });
    const second = locks.runExclusive("a", async () => { order.push("a2"); });
    const other = locks.runExclusive("b", async () => { order.push("b"); });
    await other;
    expect(order).toEqual(["a1-start", "b"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["a1-start", "b", "a1-end", "a2"]);
  });

  it("locks multi-path groups in stable order and reports independent failures", async () => {
    const locks = new PathLockManager();
    const group = await locks.runExclusiveMany(["b", "a", "b"], async () => "group");
    expect(group).toBe("group");
    const results = await locks.runIndependent(["bad", "good"], async (path) => {
      if (path === "bad") throw new Error("blocked");
      return path.toUpperCase();
    });
    expect(results.map((result) => [result.path, result.status])).toEqual([["bad", "rejected"], ["good", "fulfilled"]]);
    expect(results[1]).toMatchObject({ value: "GOOD" });
  });
});

interface CoordinatorOptions {
  lock?: VaultCoordinationLock;
  clock?: FakeClock;
  instanceId?: string;
  vaultId?: string;
  settings?: Partial<CoordinatorSettings>;
}

async function readyCoordinator(pipeline: FakePipeline, options: CoordinatorOptions = {}): Promise<SyncCoordinator> {
  const value = createCoordinator(pipeline, options);
  await value.initialize();
  return value;
}

function createCoordinator(pipeline: FakePipeline, options: CoordinatorOptions = {}): SyncCoordinator {
  const settings: CoordinatorSettings = {
    startup: false,
    events: true,
    polling: false,
    ...options.settings,
  };
  return new SyncCoordinator({
    vaultId: options.vaultId ?? crypto.randomUUID(),
    instanceId: options.instanceId ?? crypto.randomUUID(),
    pipeline,
    ...(Object.prototype.hasOwnProperty.call(options, "lock") ? { lock: options.lock } : { lock: new InProcessVaultCoordinationLock() }),
    clock: options.clock ?? new FakeClock(),
    settings,
  });
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition not reached");
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(abortError()); };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}
