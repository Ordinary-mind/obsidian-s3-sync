import { RepositoryOperationLock, type RepositoryOperationOwner } from "../core/repository-operation-lock";
import { DiagnosticError } from "../core/diagnostics";

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
    if (this.disposed) {
      throw new DiagnosticError(
        "REPOSITORY_OPERATION_RUNTIME_DISPOSED",
        "cancelled",
        "repository operation runtime is disposed",
      );
    }
    if (!this.lock.tryAcquire(owner)) {
      throw new DiagnosticError(
        "REPOSITORY_OPERATION_BUSY",
        "cancelled",
        "another repository operation is already running",
      );
    }
    this.controller = new AbortController();
  }

  assertHeldBy(owner: RepositoryOperationOwner): void {
    if (!this.lock.isHeldBy(owner)) {
      throw new DiagnosticError(
        "REPOSITORY_OPERATION_OWNERSHIP_INVALID",
        "internal",
        "repository operation is not held by the expected owner",
      );
    }
    if (!this.controller) {
      throw new DiagnosticError(
        "REPOSITORY_OPERATION_SIGNAL_MISSING",
        "internal",
        "repository operation signal is missing",
      );
    }
  }

  throwIfAborted(owner: RepositoryOperationOwner): void {
    this.assertHeldBy(owner);
    this.controller!.signal.throwIfAborted();
  }

  abort(owner: RepositoryOperationOwner): void {
    if (!this.lock.isHeldBy(owner)) return;
    this.controller?.abort(operationAbortError("repository operation cancelled"));
  }

  release(owner: RepositoryOperationOwner): void {
    if (!this.lock.isHeldBy(owner)) {
      throw new DiagnosticError(
        "REPOSITORY_OPERATION_OWNERSHIP_INVALID",
        "internal",
        "repository operation cannot be released by another owner",
      );
    }
    this.controller?.abort(operationAbortError("repository operation completed"));
    this.controller = undefined;
    this.lock.release(owner);
  }

  dispose(): void {
    this.disposed = true;
    this.controller?.abort(operationAbortError("plugin unloaded"));
  }
}

function operationAbortError(message: string): DiagnosticError {
  const error = new DiagnosticError(
    "REPOSITORY_OPERATION_CANCELLED",
    "cancelled",
    message,
  );
  error.name = "AbortError";
  return error;
}
