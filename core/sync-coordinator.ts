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
}

export class SyncCoordinatorError extends Error {
  constructor(message: string, readonly category: SyncDiagnosticCategory | "server") {
    super(message);
    this.name = "SyncCoordinatorError";
  }
}

export class SyncCoordinator {
  private statusValue: CoordinatorStatus = {
    phase: "idle",
    running: false,
    readOnly: false,
    autoRetryStopped: false,
    retryAttempt: 0,
    pendingTriggers: [],
  };
  private settings: CoordinatorSettings;
  private lease: CoordinatorLease | undefined;
  private active: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private retryTimer: unknown;
  private stopped = false;
  private readonly listeners = new Set<(status: CoordinatorStatus) => void>();
  readonly paths = new PathLockManager();

  constructor(private readonly input: {
    vaultId: string;
    instanceId: string;
    pipeline: SyncPipeline;
    lock: VaultCoordinationLock;
    clock: CoordinatorClock;
    settings: CoordinatorSettings;
  }) {
    this.settings = { ...input.settings };
  }

  status(): CoordinatorStatus { return cloneStatus(this.statusValue); }

  onStatus(listener: (status: CoordinatorStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status());
    return () => this.listeners.delete(listener);
  }

  setSettings(settings: CoordinatorSettings): void {
    this.settings = { ...settings };
  }

  async initialize(): Promise<void> {
    if (this.stopped) throw new Error("coordinator is stopped");
    this.lease = await this.input.lock.acquire(this.input.vaultId, this.input.instanceId);
    if (!this.lease) {
      this.update({ phase: "read-only", readOnly: true });
      return;
    }
    if (this.settings.startup) await this.enqueue("startup");
  }

  async syncNow(): Promise<void> { await this.enqueue("manual"); }
  async notifyLocalEvent(): Promise<void> { if (this.settings.events) await this.enqueue("event"); }
  async notifyPoll(): Promise<void> { if (this.settings.polling) await this.enqueue("poll"); }

  async previewNow(): Promise<PreviewPlan> {
    this.assertUsable(true);
    const controller = new AbortController();
    this.update({ phase: "previewing" });
    try {
      return await this.input.pipeline.buildPreview({ signal: controller.signal, trigger: "manual", paths: this.paths });
    } finally {
      if (!this.statusValue.running) this.update({ phase: this.statusValue.readOnly ? "read-only" : "idle" });
    }
  }

  async executePreview(plan: PreviewPlan): Promise<void> {
    this.assertUsable(false);
    const controller = new AbortController();
    const context = { signal: controller.signal, trigger: "manual" as const, paths: this.paths };
    if (!(await this.input.pipeline.revalidatePreview(plan, context))) throw new Error("preview plan is stale");
    await this.input.pipeline.executePreview(plan, context);
  }

  async fullAudit(): Promise<void> {
    this.assertUsable(true);
    if (this.active) await this.active;
    const controller = new AbortController();
    this.controller = controller;
    this.update({ phase: "auditing", running: true, auditProgress: { completed: 0, total: 0 } });
    try {
      await this.input.pipeline.fullAudit(
        { signal: controller.signal, trigger: "manual", paths: this.paths },
        (completed, total) => this.update({ auditProgress: { completed, total } }),
      );
    } finally {
      this.controller = undefined;
      this.update({ phase: this.statusValue.readOnly ? "read-only" : "idle", running: false });
    }
  }

  async retryNow(): Promise<void> {
    this.cancelRetry();
    this.update({ autoRetryStopped: false, retryAttempt: 0, retryAt: undefined });
    await this.enqueue("manual");
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelRetry();
    this.controller?.abort();
    try { await this.active; } catch { /* 停止时只等待持久边界完成。 */ }
    await this.lease?.release();
    this.lease = undefined;
    this.update({ phase: "stopped", running: false, pendingTriggers: [] });
  }

  private enqueue(trigger: SyncTrigger): Promise<void> {
    this.assertUsable(false);
    if (this.statusValue.autoRetryStopped && trigger !== "manual") return Promise.resolve();
    const pending = [...this.statusValue.pendingTriggers, trigger];
    this.update({ pendingTriggers: [...new Set(pending)] });
    if (!this.active) {
      this.active = this.drain().finally(() => { this.active = undefined; });
    }
    return this.active;
  }

  private async drain(): Promise<void> {
    while (!this.stopped && this.statusValue.pendingTriggers.length > 0) {
      const trigger = this.statusValue.pendingTriggers[0];
      this.update({ pendingTriggers: this.statusValue.pendingTriggers.slice(1) });
      try {
        await this.runRound(trigger);
        this.cancelRetry();
        this.update({ retryAttempt: 0, retryAt: undefined, lastErrorCategory: undefined, autoRetryStopped: false });
      } catch (error) {
        if (isAbort(error) && this.stopped) break;
        this.handleRoundFailure(error);
        break;
      }
    }
    if (!this.stopped) {
      const phase = this.statusValue.retryAt !== undefined
        ? "waiting-retry"
        : this.statusValue.readOnly ? "read-only" : "idle";
      this.update({ phase, running: false });
    }
  }

  private async runRound(trigger: SyncTrigger): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    this.update({ running: true });
    const context = { signal: controller.signal, trigger, paths: this.paths };
    try {
      await this.stage("recovering", () => this.input.pipeline.recover(context));
      await this.stage("verifying-repository", () => this.input.pipeline.verifyRepository(context));
      await this.stage("pulling", () => this.input.pipeline.pull(context));
      await this.stage("merging", () => this.input.pipeline.persistMerge(context));
      await this.stage("applying", () => this.input.pipeline.applyVault(context));
      await this.stage("scanning", () => this.input.pipeline.detectLocalChanges(context));
      await this.stage("repulling", () => this.input.pipeline.repull(context));
      await this.stage("freezing-outbox", () => this.input.pipeline.freezeOutbox(context));
      await this.stage("publishing", () => this.input.pipeline.publishOutbox(context));
      await this.stage("verifying-publication", () => this.input.pipeline.verifyPublished(context));
    } finally {
      this.controller = undefined;
    }
  }

  private async stage(phase: CoordinatorPhase, operation: () => Promise<void>): Promise<void> {
    if (this.controller?.signal.aborted) throw abortError();
    this.update({ phase });
    await operation();
    if (this.controller?.signal.aborted) throw abortError();
  }

  private handleRoundFailure(error: unknown): void {
    const category = error instanceof SyncCoordinatorError ? error.category : "integrity";
    const normalizedCategory: SyncDiagnosticCategory = category === "server" ? "network" : category;
    this.update({ lastErrorCategory: normalizedCategory });
    if (category === "authentication" || category === "integrity" || category === "repository-identity") {
      this.update({ autoRetryStopped: true });
      return;
    }
    const attempt = this.statusValue.retryAttempt + 1;
    const delay = retryDelayMs(attempt - 1);
    const retryAt = this.input.clock.now() + delay;
    this.update({ phase: "waiting-retry", retryAttempt: attempt, retryAt });
    this.cancelRetry();
    this.retryTimer = this.input.clock.setTimer(() => {
      this.retryTimer = undefined;
      if (!this.stopped) void this.enqueue("retry");
    }, delay);
  }

  private cancelRetry(): void {
    if (this.retryTimer !== undefined) this.input.clock.clearTimer(this.retryTimer);
    this.retryTimer = undefined;
  }

  private assertUsable(allowReadOnly: boolean): void {
    if (this.stopped) throw new Error("coordinator is stopped");
    if (!allowReadOnly && this.statusValue.readOnly) throw new Error("another instance owns this Vault; coordinator is read-only");
  }

  private update(patch: Partial<CoordinatorStatus>): void {
    this.statusValue = { ...this.statusValue, ...patch };
    const snapshot = this.status();
    for (const listener of this.listeners) listener(snapshot);
  }
}

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
}

export class InProcessVaultCoordinationLock implements VaultCoordinationLock {
  private readonly owners = new Map<string, string>();

  async acquire(vaultId: string, instanceId: string): Promise<CoordinatorLease | undefined> {
    const owner = this.owners.get(vaultId);
    if (owner !== undefined && owner !== instanceId) return undefined;
    this.owners.set(vaultId, instanceId);
    let released = false;
    return {
      release: async () => {
        if (!released && this.owners.get(vaultId) === instanceId) this.owners.delete(vaultId);
        released = true;
      },
    };
  }
}

function cloneStatus(status: CoordinatorStatus): CoordinatorStatus {
  return {
    ...status,
    pendingTriggers: [...status.pendingTriggers],
    ...(status.auditProgress ? { auditProgress: { ...status.auditProgress } } : {}),
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("operation aborted");
  error.name = "AbortError";
  return error;
}
