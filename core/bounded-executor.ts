export interface ExecutorMetrics {
  active: number;
  queued: number;
  peakActive: number;
  completed: number;
}

export class BoundedExecutor {
  private active = 0;
  private peakActive = 0;
  private completed = 0;
  private readonly queue: Array<() => void> = [];

  constructor(readonly concurrency: number) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("executor concurrency must be a positive integer");
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      if (signal?.aborted) throw abortError();
      return await operation();
    } finally {
      this.completed += 1;
      this.release();
    }
  }

  metrics(): ExecutorMetrics {
    return { active: this.active, queued: this.queue.length, peakActive: this.peakActive, completed: this.completed };
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.active < this.concurrency) {
      this.active += 1;
      this.peakActive = Math.max(this.peakActive, this.active);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const resume = () => {
        signal?.removeEventListener("abort", onAbort);
        this.active += 1;
        this.peakActive = Math.max(this.peakActive, this.active);
        resolve();
      };
      const onAbort = () => {
        const index = this.queue.indexOf(resume);
        if (index >= 0) this.queue.splice(index, 1);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(resume);
    });
  }

  private release(): void {
    this.active -= 1;
    this.queue.shift()?.();
  }
}

function abortError(): Error { const error = new Error("operation aborted"); error.name = "AbortError"; return error; }
