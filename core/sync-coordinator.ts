import { retryDelayMs } from "./backoff";
import type { SyncDiagnosticCategory } from "./diagnostics";

export type SyncTrigger = "manual" | "startup" | "event" | "poll" | "retry";
export type CoordinatorPhase =
  | "idle"
  | "recovering"
  | "verifying-repository"
  | "pulling"
  | "merging"
  | "applying"
  | "scanning"
  | "repulling"
  | "freezing-outbox"
  | "publishing"
  | "verifying-publication"
  | "auditing"
  | "previewing"
  | "waiting-retry"
  | "read-only"
  | "stopped";

export interface PreviewPlan {
  id: string;
  repositoryFingerprint: string;
  remoteRevision: string;
  localRevision: string;
  decisions: readonly unknown[];
}

export interface CoordinatorRoundContext {
  signal: AbortSignal;
  trigger: SyncTrigger;
  triggers: readonly SyncTrigger[];
  generation: number;
  paths: PathLockManager;
}

export interface SyncPipeline {
  recover(context: CoordinatorRoundContext): Promise<void>;
  verifyRepository(context: CoordinatorRoundContext): Promise<void>;
  pull(context: CoordinatorRoundContext): Promise<void>;
  persistMerge(context: CoordinatorRoundContext): Promise<void>;
  applyVault(context: CoordinatorRoundContext): Promise<void>;
  detectLocalChanges(context: CoordinatorRoundContext): Promise<void>;
  repull(context: CoordinatorRoundContext): Promise<void>;
  freezeOutbox(context: CoordinatorRoundContext): Promise<void>;
  publishOutbox(context: CoordinatorRoundContext): Promise<void>;
  verifyPublished(context: CoordinatorRoundContext): Promise<void>;
  buildPreview(context: CoordinatorRoundContext): Promise<PreviewPlan>;
  revalidatePreview(plan: PreviewPlan, context: CoordinatorRoundContext): Promise<boolean>;
  executePreview(plan: PreviewPlan, context: CoordinatorRoundContext): Promise<void>;
  fullAudit(context: CoordinatorRoundContext, progress: (completed: number, total: number) => void): Promise<void>;
}

export interface CoordinatorClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

export class SystemCoordinatorClock implements CoordinatorClock {
  now(): number { return Date.now(); }
  setTimer(callback: () => void, delayMs: number): unknown { return globalThis.setTimeout(callback, delayMs); }
  clearTimer(handle: unknown): void { globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>); }
}

export interface CoordinatorLease {
  release(): Promise<void>;
}

export interface VaultCoordinationLock {
  acquire(vaultId: string, instanceId: string): Promise<CoordinatorLease | undefined>;
}

export interface CoordinatorStatus {
  phase: CoordinatorPhase;
  running: boolean;
  readOnly: boolean;
  autoRetryStopped: boolean;
  generation: number;
  retryAt?: number;
  retryAttempt: number;
  lastErrorCategory?: SyncDiagnosticCategory;
  pendingTriggers: SyncTrigger[];
  auditProgress?: { completed: number; total: number };
}

export interface CoordinatorSettings {
  startup: boolean;
  events: boolean;
  polling: boolean;
  pollIntervalMs?: number;
  auditIntervalMs?: number;
}

export class SyncCoordinatorError extends Error {
  constructor(message: string, readonly category: SyncDiagnosticCategory | "server") {
    super(message);
    this.name = "SyncCoordinatorError";
  }
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

const triggerOrder: readonly SyncTrigger[] = ["manual", "startup", "event", "poll", "retry"];
const defaultPollIntervalMs = 60_000;

export class SyncCoordinator {
  private statusValue: CoordinatorStatus = {
    phase: "idle",
    running: false,
    readOnly: false,
    autoRetryStopped: false,
    generation: 0,
    retryAttempt: 0,
    pendingTriggers: [],
  };
  private settings: CoordinatorSettings;
  private readonly lock: VaultCoordinationLock;
  private lease: CoordinatorLease | undefined;
  private initializePromise: Promise<void> | undefined;
  private operationTail = Promise.resolve();
  private readonly pendingRoundWaiters: Deferred[] = [];
  private roundScheduled = false;
  private controller: AbortController | undefined;
  private retryTimer: unknown;
  private pollTimer: unknown;
  private auditTimer: unknown;
  private stopPromise: Promise<void> | undefined;
  private initialized = false;
  private stopped = false;
  private readonly listeners = new Set<(status: CoordinatorStatus) => void>();
  readonly paths = new PathLockManager();

  constructor(private readonly input: {
    vaultId: string;
    instanceId: string;
    pipeline: SyncPipeline;
    lock?: VaultCoordinationLock;
    clock: CoordinatorClock;
    settings: CoordinatorSettings;
  }) {
    this.settings = validateSettings(input.settings);
    this.lock = input.lock ?? processGlobalVaultCoordinationLock;
  }

  status(): CoordinatorStatus { return cloneStatus(this.statusValue); }

  onStatus(listener: (status: CoordinatorStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status());
    return () => this.listeners.delete(listener);
  }

  setSettings(settings: CoordinatorSettings): void {
    if (this.stopped) throw new Error("coordinator is stopped");
    this.settings = validateSettings(settings);
    if (this.initialized && !this.statusValue.readOnly) this.scheduleAutomationTimers();
  }

  initialize(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("coordinator is stopped"));
    this.initializePromise ??= this.initializeOnce();
    return this.initializePromise;
  }

  async syncNow(): Promise<void> { await this.enqueue("manual"); }
  async notifyLocalEvent(): Promise<void> { if (this.settings.events) await this.enqueue("event"); }
  async notifyPoll(): Promise<void> { if (this.settings.polling) await this.enqueue("poll"); }

  async previewNow(): Promise<PreviewPlan> {
    this.assertUsable(true);
    return this.scheduleOperation(async () => {
      this.assertUsable(true);
      const controller = this.beginControlledOperation("previewing");
      const context = this.auxiliaryContext(controller);
      try {
        return await this.input.pipeline.buildPreview(context);
      } finally {
        this.finishControlledOperation(controller);
      }
    });
  }

  async executePreview(plan: PreviewPlan): Promise<void> {
    this.assertUsable(false);
    await this.scheduleOperation(async () => {
      this.assertUsable(false);
      const controller = this.beginControlledOperation("previewing");
      const context = this.auxiliaryContext(controller);
      try {
        if (!(await this.input.pipeline.revalidatePreview(plan, context))) throw new Error("preview plan is stale");
        this.update({ phase: "applying" });
        await this.input.pipeline.executePreview(plan, context);
      } finally {
        this.finishControlledOperation(controller);
      }
    });
  }

  async fullAudit(): Promise<void> {
    this.assertUsable(true);
    await this.scheduleOperation(async () => {
      this.assertUsable(true);
      const controller = this.beginControlledOperation("auditing");
      const context = this.auxiliaryContext(controller);
      this.update({ auditProgress: { completed: 0, total: 0 } });
      try {
        await this.input.pipeline.fullAudit(context, (completed, total) => {
          if (!this.stopped && !controller.signal.aborted) this.update({ auditProgress: { completed, total } });
        });
      } catch (error) {
        if (!isAbort(error)) this.update({ lastErrorCategory: normalizeErrorCategory(error) });
        throw error;
      } finally {
        this.finishControlledOperation(controller);
      }
    });
  }

  async retryNow(): Promise<void> {
    this.assertUsable(false);
    this.cancelRetryTimer();
    this.update({ autoRetryStopped: false, retryAttempt: 0, retryAt: undefined });
    await this.enqueue("manual");
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async initializeOnce(): Promise<void> {
    const lease = await this.lock.acquire(this.input.vaultId, this.input.instanceId);
    if (this.stopped) {
      await lease?.release();
      throw new Error("coordinator is stopped");
    }
    this.initialized = true;
    if (!lease) {
      this.update({ phase: "read-only", readOnly: true });
      return;
    }
    this.lease = lease;
    if (this.settings.startup) await this.enqueue("startup");
    this.scheduleAutomationTimers();
  }

  private async stopOnce(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelRetryTimer();
    this.cancelAutomationTimers();
    this.controller?.abort();
    const abort = abortError();
    for (const waiter of this.pendingRoundWaiters.splice(0)) waiter.reject(abort);
    this.update({ pendingTriggers: [] });
    await this.operationTail;
    await this.lease?.release();
    this.lease = undefined;
    this.update({ phase: "stopped", running: false, pendingTriggers: [] });
  }

  private enqueue(trigger: SyncTrigger): Promise<void> {
    this.assertUsable(false);
    if (this.statusValue.autoRetryStopped && trigger !== "manual") return Promise.resolve();
    if (trigger === "manual" && this.statusValue.retryAt !== undefined) {
      this.cancelRetryTimer();
      this.update({ retryAt: undefined });
    }
    const waiter = deferred();
    this.pendingRoundWaiters.push(waiter);
    this.update({ pendingTriggers: sortTriggers([...this.statusValue.pendingTriggers, trigger]) });
    this.scheduleRoundIfNeeded();
    return waiter.promise;
  }

  private scheduleRoundIfNeeded(): void {
    if (this.roundScheduled || this.stopped || this.statusValue.readOnly || this.statusValue.pendingTriggers.length === 0) return;
    const hasManualTrigger = this.statusValue.pendingTriggers.includes("manual");
    if (this.statusValue.autoRetryStopped && !hasManualTrigger) return;
    const mayBypassBackoff = hasManualTrigger || this.statusValue.pendingTriggers.includes("retry");
    if (this.statusValue.retryAt !== undefined && !mayBypassBackoff) return;
    this.roundScheduled = true;
    const scheduled = this.scheduleOperation(() => this.runPendingRound());
    const complete = () => {
      this.roundScheduled = false;
      this.scheduleRoundIfNeeded();
    };
    void scheduled.then(complete, complete);
  }

  private async runPendingRound(): Promise<void> {
    if (this.stopped) return;
    const triggers = sortTriggers(this.statusValue.pendingTriggers);
    if (triggers.length === 0) return;
    const waiters = this.pendingRoundWaiters.splice(0);
    this.update({ pendingTriggers: [] });
    try {
      await this.runRound(triggers);
      this.cancelRetryTimer();
      this.update({ retryAttempt: 0, retryAt: undefined, lastErrorCategory: undefined, autoRetryStopped: false });
      for (const waiter of waiters) waiter.resolve();
    } catch (error) {
      if (isAbort(error) && this.stopped) {
        for (const waiter of waiters) waiter.reject(error);
      } else {
        this.handleRoundFailure(error);
        for (const waiter of waiters) waiter.resolve();
      }
    } finally {
      if (!this.stopped) {
        const phase = this.statusValue.retryAt !== undefined
          ? "waiting-retry"
          : this.statusValue.readOnly ? "read-only" : "idle";
        this.update({ phase, running: false });
      }
    }
  }

  private async runRound(triggers: readonly SyncTrigger[]): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const generation = this.statusValue.generation + 1;
    this.update({ running: true, generation });
    const context: CoordinatorRoundContext = {
      signal: controller.signal,
      trigger: triggers[0],
      triggers,
      generation,
      paths: this.paths,
    };
    try {
      await this.stage(controller, "recovering", () => this.input.pipeline.recover(context));
      await this.stage(controller, "verifying-repository", () => this.input.pipeline.verifyRepository(context));
      await this.stage(controller, "pulling", () => this.input.pipeline.pull(context));
      await this.stage(controller, "merging", () => this.input.pipeline.persistMerge(context));
      await this.stage(controller, "applying", () => this.input.pipeline.applyVault(context));
      await this.stage(controller, "scanning", () => this.input.pipeline.detectLocalChanges(context));
      await this.stage(controller, "repulling", () => this.input.pipeline.repull(context));
      await this.stage(controller, "freezing-outbox", () => this.input.pipeline.freezeOutbox(context));
      await this.stage(controller, "publishing", () => this.input.pipeline.publishOutbox(context));
      await this.stage(controller, "verifying-publication", () => this.input.pipeline.verifyPublished(context));
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }

  private async stage(controller: AbortController, phase: CoordinatorPhase, operation: () => Promise<void>): Promise<void> {
    if (controller.signal.aborted) throw abortError();
    this.update({ phase });
    await operation();
    if (controller.signal.aborted) throw abortError();
  }

  private handleRoundFailure(error: unknown): void {
    const category = error instanceof SyncCoordinatorError ? error.category : "integrity";
    const normalizedCategory: SyncDiagnosticCategory = category === "server" ? "network" : category;
    this.update({ lastErrorCategory: normalizedCategory });
    this.cancelRetryTimer();
    if (category === "authentication" || category === "integrity" || category === "repository-identity") {
      this.update({ autoRetryStopped: true, retryAt: undefined });
      return;
    }
    if (category === "local-path" || category === "conflict") {
      this.update({ autoRetryStopped: false, retryAt: undefined });
      return;
    }
    const attempt = this.statusValue.retryAttempt + 1;
    const delay = retryDelayMs(attempt - 1);
    const retryAt = this.input.clock.now() + delay;
    this.update({ phase: "waiting-retry", retryAttempt: attempt, retryAt, autoRetryStopped: false });
    this.retryTimer = this.input.clock.setTimer(() => {
      this.retryTimer = undefined;
      if (this.stopped) return;
      this.update({ retryAt: undefined });
      void this.enqueue("retry");
    }, delay);
  }

  private scheduleAutomationTimers(): void {
    this.schedulePollTimer();
    this.scheduleAuditTimer();
  }

  private schedulePollTimer(): void {
    if (this.pollTimer !== undefined) this.input.clock.clearTimer(this.pollTimer);
    this.pollTimer = undefined;
    if (this.stopped || this.statusValue.readOnly || !this.settings.polling) return;
    const delay = this.settings.pollIntervalMs ?? defaultPollIntervalMs;
    this.pollTimer = this.input.clock.setTimer(() => {
      this.pollTimer = undefined;
      const poll = this.notifyPoll();
      void poll.then(() => this.schedulePollTimer(), () => this.schedulePollTimer());
    }, delay);
  }

  private scheduleAuditTimer(): void {
    if (this.auditTimer !== undefined) this.input.clock.clearTimer(this.auditTimer);
    this.auditTimer = undefined;
    if (this.stopped || this.statusValue.readOnly || this.settings.auditIntervalMs === undefined) return;
    this.auditTimer = this.input.clock.setTimer(() => {
      this.auditTimer = undefined;
      const audit = this.fullAudit();
      void audit.then(() => this.scheduleAuditTimer(), () => this.scheduleAuditTimer());
    }, this.settings.auditIntervalMs);
  }

  private cancelAutomationTimers(): void {
    if (this.pollTimer !== undefined) this.input.clock.clearTimer(this.pollTimer);
    if (this.auditTimer !== undefined) this.input.clock.clearTimer(this.auditTimer);
    this.pollTimer = undefined;
    this.auditTimer = undefined;
  }

  private cancelRetryTimer(): void {
    if (this.retryTimer !== undefined) this.input.clock.clearTimer(this.retryTimer);
    this.retryTimer = undefined;
  }

  private beginControlledOperation(phase: CoordinatorPhase): AbortController {
    const controller = new AbortController();
    this.controller = controller;
    this.update({ phase, running: true });
    return controller;
  }

  private finishControlledOperation(controller: AbortController): void {
    if (this.controller === controller) this.controller = undefined;
    if (this.stopped) return;
    const phase = this.statusValue.retryAt !== undefined
      ? "waiting-retry"
      : this.statusValue.readOnly ? "read-only" : "idle";
    this.update({ phase, running: false });
  }

  private auxiliaryContext(controller: AbortController): CoordinatorRoundContext {
    return {
      signal: controller.signal,
      trigger: "manual",
      triggers: ["manual"],
      generation: this.statusValue.generation,
      paths: this.paths,
    };
  }

  private scheduleOperation<T>(operation: () => Promise<T>): Promise<T> {
    const scheduled = this.operationTail.then(operation);
    this.operationTail = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }

  private assertUsable(allowReadOnly: boolean): void {
    if (this.stopped) throw new Error("coordinator is stopped");
    if (!this.initialized) throw new Error("coordinator is not initialized");
    if (!allowReadOnly && this.statusValue.readOnly) throw new Error("another instance owns this Vault; coordinator is read-only");
  }

  private update(patch: Partial<CoordinatorStatus>): void {
    this.statusValue = { ...this.statusValue, ...patch };
    const snapshot = this.status();
    for (const listener of this.listeners) listener(snapshot);
  }
}

export type PathOperationResult<T> =
  | { path: string; status: "fulfilled"; value: T }
  | { path: string; status: "rejected"; error: unknown };

export class PathLockManager {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(path) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.tails.set(path, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(path) === tail) this.tails.delete(path);
    }
  }

  async runExclusiveMany<T>(paths: readonly string[], operation: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(paths)].sort();
    const acquire = (index: number): Promise<T> => index === ordered.length
      ? operation()
      : this.runExclusive(ordered[index], () => acquire(index + 1));
    return acquire(0);
  }

  async runIndependent<T>(paths: readonly string[], operation: (path: string) => Promise<T>): Promise<PathOperationResult<T>[]> {
    return Promise.all(paths.map(async (path): Promise<PathOperationResult<T>> => {
      try {
        return { path, status: "fulfilled", value: await this.runExclusive(path, () => operation(path)) };
      } catch (error) {
        return { path, status: "rejected", error };
      }
    }));
  }
}

export class InProcessVaultCoordinationLock implements VaultCoordinationLock {
  private readonly owners = new Map<string, symbol>();

  async acquire(vaultId: string, instanceId: string): Promise<CoordinatorLease | undefined> {
    if (this.owners.has(vaultId)) return undefined;
    const token = Symbol(instanceId);
    this.owners.set(vaultId, token);
    let released = false;
    return {
      release: async () => {
        if (!released && this.owners.get(vaultId) === token) this.owners.delete(vaultId);
        released = true;
      },
    };
  }
}

export const processGlobalVaultCoordinationLock: VaultCoordinationLock = new InProcessVaultCoordinationLock();

function validateSettings(settings: CoordinatorSettings): CoordinatorSettings {
  if (settings.pollIntervalMs !== undefined && (!Number.isSafeInteger(settings.pollIntervalMs) || settings.pollIntervalMs <= 0)) {
    throw new Error("poll interval must be a positive integer");
  }
  if (settings.auditIntervalMs !== undefined && (!Number.isSafeInteger(settings.auditIntervalMs) || settings.auditIntervalMs <= 0)) {
    throw new Error("audit interval must be a positive integer");
  }
  return { ...settings };
}

function sortTriggers(triggers: readonly SyncTrigger[]): SyncTrigger[] {
  const values = new Set(triggers);
  return triggerOrder.filter((trigger) => values.has(trigger));
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function cloneStatus(status: CoordinatorStatus): CoordinatorStatus {
  return {
    ...status,
    pendingTriggers: [...status.pendingTriggers],
    ...(status.auditProgress ? { auditProgress: { ...status.auditProgress } } : {}),
  };
}

function normalizeErrorCategory(error: unknown): SyncDiagnosticCategory {
  if (!(error instanceof SyncCoordinatorError)) return "integrity";
  return error.category === "server" ? "network" : error.category;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("operation aborted");
  error.name = "AbortError";
  return error;
}
