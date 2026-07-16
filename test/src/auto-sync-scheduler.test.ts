import { describe, expect, it } from "vitest";
import { AutoSyncScheduler, type AutoSyncTimerHost } from "../../src/auto-sync-scheduler";

class FakeTimers implements AutoSyncTimerHost {
  private nextId = 1;
  readonly pending = new Map<number, { callback: () => void; delayMs: number }>();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.pending.set(id, { callback, delayMs });
    return id;
  }

  clearTimeout(handle: unknown): void { this.pending.delete(handle as number); }

  fire(delayMs: number): void {
    const entry = [...this.pending.entries()].find(([, timer]) => timer.delayMs === delayMs);
    if (!entry) throw new Error(`timer ${delayMs} not found`);
    this.pending.delete(entry[0]);
    entry[1].callback();
  }
}

describe("auto-sync scheduler", () => {
  it("uses one fixed startup run and one periodic poll", async () => {
    const timers = new FakeTimers();
    let runs = 0;
    const scheduler = new AutoSyncScheduler(async () => { runs += 1; }, {
      timers,
      startupDelayMs: 3,
      debounceMs: 5,
      pollIntervalMs: 20,
    });
    scheduler.setEnabled(true);
    scheduler.resume(true);
    timers.fire(3);
    await Promise.resolve();
    await Promise.resolve();
    expect(runs).toBe(1);
    expect([...timers.pending.values()].some((timer) => timer.delayMs === 20)).toBe(true);
  });

  it("debounces local changes and stops all future timers when disabled", async () => {
    const timers = new FakeTimers();
    let runs = 0;
    const scheduler = new AutoSyncScheduler(async () => { runs += 1; }, {
      timers,
      startupDelayMs: 3,
      debounceMs: 5,
      pollIntervalMs: 20,
    });
    scheduler.setEnabled(true);
    scheduler.resume();
    scheduler.notifyChange();
    scheduler.notifyChange();
    expect([...timers.pending.values()].filter((timer) => timer.delayMs === 5)).toHaveLength(1);
    timers.fire(5);
    await Promise.resolve();
    await Promise.resolve();
    expect(runs).toBe(1);
    scheduler.setEnabled(false);
    expect(timers.pending.size).toBe(0);
  });

  it("does not schedule while suspended", () => {
    const timers = new FakeTimers();
    const scheduler = new AutoSyncScheduler(async () => undefined, { timers });
    scheduler.setEnabled(true);
    scheduler.notifyChange();
    expect(timers.pending.size).toBe(0);
    scheduler.resume();
    scheduler.suspend();
    expect(timers.pending.size).toBe(0);
  });

  it("reports scheduled failures instead of silently swallowing them", async () => {
    const timers = new FakeTimers();
    const errors: unknown[] = [];
    const failure = new Error("scheduled failure");
    const scheduler = new AutoSyncScheduler(async () => { throw failure; }, {
      timers,
      startupDelayMs: 3,
      onError: (error) => errors.push(error),
    });
    scheduler.setEnabled(true);
    scheduler.resume(true);
    timers.fire(3);
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toEqual([failure]);
  });
});
