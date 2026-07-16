import { RepositoryOperationLock, type RepositoryOperationOwner } from "../core/repository-operation-lock";

export class RepositoryOperationRuntime {
  private readonly lock = new RepositoryOperationLock();
  private controller: AbortController | undefined;
  private disposed = false;

  isRunning(): boolean {
    return this.lock.isRunning();
  }

  isHeldBy(owner: RepositoryOperationOwner): boolean {
    return this.lock.isHeldBy(owner);
  }

  currentOwner(): RepositoryOperationOwner | undefined {
    return this.lock.currentOwner();
  }

  currentSignal(): AbortSignal | undefined {
    return this.controller?.signal;
  }

  tryAcquire(owner: RepositoryOperationOwner): boolean {
    if (this.disposed || !this.lock.tryAcquire(owner)) return false;
    this.controller = new AbortController();
    return true;
  }

  acquire(owner: RepositoryOperationOwner): void {
    if (this.disposed) throw new Error("repository operation runtime is disposed");
    this.lock.acquire(owner);
    this.controller = new AbortController();
  }

  assertHeldBy(owner: RepositoryOperationOwner): void {
    this.lock.assertHeldBy(owner);
    if (!this.controller) throw new Error("repository operation signal is missing");
  }

  throwIfAborted(owner: RepositoryOperationOwner): void {
    this.assertHeldBy(owner);
    this.controller!.signal.throwIfAborted();
  }

  abort(owner: RepositoryOperationOwner): void {
    if (!this.lock.isHeldBy(owner)) return;
    this.controller?.abort(new Error("repository operation cancelled"));
  }

  release(owner: RepositoryOperationOwner): void {
    this.lock.assertHeldBy(owner);
    this.controller?.abort(new Error("repository operation completed"));
    this.controller = undefined;
    this.lock.release(owner);
  }

  dispose(): void {
    this.disposed = true;
    this.controller?.abort(new Error("plugin unloaded"));
  }
}
