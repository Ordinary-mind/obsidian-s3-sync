export interface AutoSyncTimerHost {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AutoSyncSchedulerOptions {
  debounceMs?: number;
  startupDelayMs?: number;
  pollIntervalMs?: number;
  timers?: AutoSyncTimerHost;
  onError?: (error: unknown) => void;
}

const defaultTimers: AutoSyncTimerHost = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

export class AutoSyncScheduler {
  private readonly debounceMs: number;
  private readonly startupDelayMs: number;
  private readonly pollIntervalMs: number;
  private readonly timers: AutoSyncTimerHost;
  private readonly onError: (error: unknown) => void;
  private enabled = false;
  private suspended = true;
  private stopped = false;
  private running = false;
  private pending = false;
  private runTimer: unknown;
  private pollTimer: unknown;

  constructor(private readonly run: () => Promise<void>, options: AutoSyncSchedulerOptions = {}) {
    this.debounceMs = positiveDelay(options.debounceMs ?? 10_000, "debounce");
    this.startupDelayMs = positiveDelay(options.startupDelayMs ?? 3_000, "startup");
    this.pollIntervalMs = positiveDelay(options.pollIntervalMs ?? 5 * 60_000, "poll");
    this.timers = options.timers ?? defaultTimers;
    this.onError = options.onError ?? (() => undefined);
  }

  setEnabled(enabled: boolean, runSoon = false): void {
    if (this.stopped) return;
    this.enabled = enabled;
    if (!enabled) {
      this.pending = false;
      this.clearTimers();
      return;
    }
    if (!this.suspended) {
      if (runSoon) this.scheduleRun(this.startupDelayMs);
      this.schedulePoll();
    }
  }

  resume(runSoon = false): void {
    if (this.stopped) return;
    this.suspended = false;
    if (!this.enabled) return;
    if (runSoon) this.scheduleRun(this.startupDelayMs);
    this.schedulePoll();
  }

  suspend(): void {
    this.suspended = true;
    this.clearTimers();
  }

  notifyChange(): void {
    if (!this.enabled || this.suspended || this.stopped) return;
    if (this.running) {
      this.pending = true;
      return;
    }
    this.scheduleRun(this.debounceMs);
  }

  stop(): void {
    this.stopped = true;
    this.enabled = false;
    this.pending = false;
    this.clearTimers();
  }

  private scheduleRun(delayMs: number): void {
    if (!this.enabled || this.suspended || this.stopped) return;
    if (this.runTimer !== undefined) this.timers.clearTimeout(this.runTimer);
    this.runTimer = this.timers.setTimeout(() => {
      this.runTimer = undefined;
      this.runScheduled();
    }, delayMs);
  }

  private runScheduled(): void {
    if (!this.enabled || this.suspended || this.stopped) return;
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    if (this.pollTimer !== undefined) this.timers.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    void this.run().catch((error) => this.onError(error)).finally(() => {
      this.running = false;
      if (this.stopped || this.suspended || !this.enabled) return;
      if (this.pending) {
        this.pending = false;
        this.scheduleRun(this.debounceMs);
      }
      this.schedulePoll();
    });
  }

  private schedulePoll(): void {
    if (!this.enabled || this.suspended || this.stopped || this.pollTimer !== undefined) return;
    this.pollTimer = this.timers.setTimeout(() => {
      this.pollTimer = undefined;
      this.runScheduled();
    }, this.pollIntervalMs);
  }

  private clearTimers(): void {
    if (this.runTimer !== undefined) this.timers.clearTimeout(this.runTimer);
    if (this.pollTimer !== undefined) this.timers.clearTimeout(this.pollTimer);
    this.runTimer = undefined;
    this.pollTimer = undefined;
  }
}

function positiveDelay(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`auto-sync ${label} delay is invalid`);
  return value;
}
