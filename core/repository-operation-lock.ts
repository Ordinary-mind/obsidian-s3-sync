export type RepositoryOperationOwner = "config" | "vault";

export class RepositoryOperationLock {
  private owner: RepositoryOperationOwner | undefined;

  isRunning(): boolean {
    return this.owner !== undefined;
  }

  isHeldBy(owner: RepositoryOperationOwner): boolean {
    return this.owner === owner;
  }

  currentOwner(): RepositoryOperationOwner | undefined {
    return this.owner;
  }

  tryAcquire(owner: RepositoryOperationOwner): boolean {
    if (this.owner !== undefined) return false;
    this.owner = owner;
    return true;
  }

  acquire(owner: RepositoryOperationOwner): void {
    if (!this.tryAcquire(owner)) throw new Error(`repository operation is already held by ${this.owner}`);
  }

  assertHeldBy(owner: RepositoryOperationOwner): void {
    if (this.owner !== owner) throw new Error(`repository operation is not held by ${owner}`);
  }

  release(owner: RepositoryOperationOwner): void {
    this.assertHeldBy(owner);
    this.owner = undefined;
  }
}
