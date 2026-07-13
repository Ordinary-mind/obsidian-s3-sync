import { describe, expect, it } from "vitest";
import {
  InProcessVaultCoordinationLock,
  PathLockManager,
  SyncCoordinator,
  SyncCoordinatorError,
  type CoordinatorClock,
  type CoordinatorRoundContext,
  type PreviewPlan,
  type SyncPipeline,
} from "../../core/sync-coordinator";

class FakeClock implements CoordinatorClock {
  time = 100;
  nextId = 1;
  readonly timers = new Map<number, { callback: () => void; delay: number }>();
  now(): number { return this.time; }
  setTimer(callback: () => void, delay: number): unknown { const id = this.nextId++; this.timers.set(id, { callback, delay }); return id; }
  clearTimer(handle: unknown): void { this.timers.delete(handle as number); }
  fire(): void { const timer = [...this.timers.entries()][0]; if (!timer) throw new Error("no timer"); this.timers.delete(timer[0]); this.time += timer[1].delay; timer[1].callback(); }
}

class FakePipeline implements SyncPipeline {
  readonly calls: string[] = [];
  failure?: { stage: string; error: Error };
  pullGate?: Promise<void>;
  onPull?: () => void;
  previewValid = true;
  readonly preview: PreviewPlan = { id: "preview", repositoryFingerprint: "fingerprint", remoteRevision: "remote", localRevision: "local", decisions: [] };

  recover = (context: CoordinatorRoundContext) => this.call("recover", context);
  verifyRepository = (context: CoordinatorRoundContext) => this.call("verify", context);
  pull = async (context: CoordinatorRoundContext) => { this.onPull?.(); await this.call("pull", context); await this.pullGate; };
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
  async fullAudit(_context: CoordinatorRoundContext, progress: (completed: number, total: number) => void): Promise<void> { this.calls.push("audit"); progress(1, 2); progress(2, 2); }

  private async call(stage: string, context: CoordinatorRoundContext): Promise<void> {
    if (context.signal.aborted) throw abortError();
    this.calls.push(stage);
    if (this.failure?.stage === stage) throw this.failure.error;
  }
}

describe("sync coordinator", () => {
  it("executes the frozen single-round order", async () => {
    const pipeline = new FakePipeline();
    const coordinator = await readyCoordinator(pipeline);
    await coordinator.syncNow();
    expect(pipeline.calls).toEqual(["recover", "verify", "pull", "merge", "apply", "scan", "repull", "freeze", "publish", "verify-published"]);
    expect(coordinator.status()).toMatchObject({ phase: "idle", running: false, pendingTriggers: [] });
  });

  it("queues events raised during a round into one following generation", async () => {
    const pipeline = new FakePipeline();
    let release!: () => void;
    let entered!: () => void;
    const enteredPull = new Promise<void>((resolve) => { entered = resolve; });
    pipeline.pullGate = new Promise<void>((resolve) => { release = resolve; });
    pipeline.onPull = entered;
    const coordinator = await readyCoordinator(pipeline);
    const running = coordinator.syncNow();
    await enteredPull;
    const queuedOne = coordinator.notifyLocalEvent();
    const queuedTwo = coordinator.notifyLocalEvent();
    release();
    await Promise.all([running, queuedOne, queuedTwo]);
    expect(pipeline.calls.filter((call) => call === "recover")).toHaveLength(2);
  });

  it("puts a second instance for the same Vault into read-only diagnostics", async () => {
    const lock = new InProcessVaultCoordinationLock();
    const first = coordinator(new FakePipeline(), lock, "one");
    const second = coordinator(new FakePipeline(), lock, "two");
    await first.initialize();
    await second.initialize();
    expect(second.status()).toMatchObject({ phase: "read-only", readOnly: true });
    await expect(second.syncNow()).rejects.toThrow("read-only");
    await expect(second.previewNow()).resolves.toMatchObject({ id: "preview" });
    await first.stop();
    await second.stop();
  });

  it("stops automatic retry for auth and schedules exponential retry for network failures", async () => {
    const authPipeline = new FakePipeline();
    authPipeline.failure = { stage: "pull", error: new SyncCoordinatorError("denied", "authentication") };
    const auth = await readyCoordinator(authPipeline);
    await auth.syncNow();
    expect(auth.status()).toMatchObject({ autoRetryStopped: true, lastErrorCategory: "authentication" });

    const networkPipeline = new FakePipeline();
    networkPipeline.failure = { stage: "pull", error: new SyncCoordinatorError("offline", "network") };
    const clock = new FakeClock();
    const network = await readyCoordinator(networkPipeline, new InProcessVaultCoordinationLock(), clock);
    await network.syncNow();
    expect(network.status()).toMatchObject({ phase: "waiting-retry", retryAttempt: 1, retryAt: 1100 });
    networkPipeline.failure = undefined;
    clock.fire();
    await eventually(() => network.status().retryAttempt === 0 && !network.status().running);
    expect(networkPipeline.calls.filter((call) => call === "recover")).toHaveLength(2);
  });

  it("revalidates previews, reports audit progress, and never executes a stale plan", async () => {
    const pipeline = new FakePipeline();
    const coordinator = await readyCoordinator(pipeline);
    const plan = await coordinator.previewNow();
    pipeline.previewValid = false;
    await expect(coordinator.executePreview(plan)).rejects.toThrow("stale");
    expect(pipeline.calls).not.toContain("execute-preview");
    await coordinator.fullAudit();
    expect(coordinator.status().auditProgress).toEqual({ completed: 2, total: 2 });
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
});

async function readyCoordinator(
  pipeline: FakePipeline,
  lock = new InProcessVaultCoordinationLock(),
  clock = new FakeClock(),
): Promise<SyncCoordinator> {
  const value = coordinator(pipeline, lock, crypto.randomUUID(), clock);
  await value.initialize();
  return value;
}

function coordinator(pipeline: FakePipeline, lock: InProcessVaultCoordinationLock, instanceId: string, clock = new FakeClock()): SyncCoordinator {
  return new SyncCoordinator({ vaultId: "vault", instanceId, pipeline, lock, clock, settings: { startup: false, events: true, polling: true } });
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition not reached");
}

function abortError(): Error { const error = new Error("aborted"); error.name = "AbortError"; return error; }
