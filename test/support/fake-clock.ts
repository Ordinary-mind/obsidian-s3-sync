export class FakeClock {
  private nowMilliseconds = 0;
  private nextId = 0;
  private readonly tasks = new Map<number, { dueAt: number; callback: () => void }>();

  now(): number {
    return this.nowMilliseconds;
  }

  schedule(delayMilliseconds: number, callback: () => void): number {
    if (!Number.isSafeInteger(delayMilliseconds) || delayMilliseconds < 0) {
      throw new RangeError("delay must be a non-negative safe integer");
    }
    const id = this.nextId++;
    this.tasks.set(id, { dueAt: this.nowMilliseconds + delayMilliseconds, callback });
    return id;
  }

  cancel(id: number): void {
    this.tasks.delete(id);
  }

  advance(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new RangeError("advance must be a non-negative safe integer");
    }
    const target = this.nowMilliseconds + milliseconds;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.dueAt <= target)
        .sort(([leftId, left], [rightId, right]) => left.dueAt - right.dueAt || leftId - rightId)[0];
      if (!next) break;
      const [id, task] = next;
      this.tasks.delete(id);
      this.nowMilliseconds = task.dueAt;
      task.callback();
    }
    this.nowMilliseconds = target;
  }
}
