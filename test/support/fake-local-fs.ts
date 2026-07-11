export type LocalFsOperation = "read" | "write" | "rename" | "delete" | "persist-state";
export type BoundaryPhase = "before" | "after";

export class FakeCrash extends Error {
  constructor(message = "injected crash") {
    super(message);
    this.name = "FakeCrash";
  }
}

export class FakeLocalFs {
  private readonly files = new Map<string, Uint8Array>();
  private state: Uint8Array | undefined;
  private hook: ((operation: LocalFsOperation, phase: BoundaryPhase, path: string) => void) | undefined;

  setBoundaryHook(hook: (operation: LocalFsOperation, phase: BoundaryPhase, path: string) => void): void {
    this.hook = hook;
  }

  seed(path: string, body: Uint8Array): void {
    this.files.set(path, copy(body));
  }

  read(path: string): Uint8Array {
    this.boundary("read", "before", path);
    const body = this.files.get(path);
    if (!body) throw new Error(`file not found: ${path}`);
    const result = copy(body);
    this.boundary("read", "after", path);
    return result;
  }

  write(path: string, body: Uint8Array): void {
    this.boundary("write", "before", path);
    this.files.set(path, copy(body));
    this.boundary("write", "after", path);
  }

  rename(from: string, to: string): void {
    this.boundary("rename", "before", from);
    const body = this.files.get(from);
    if (!body) throw new Error(`file not found: ${from}`);
    if (this.files.has(to)) throw new Error(`destination exists: ${to}`);
    this.files.delete(from);
    this.files.set(to, body);
    this.boundary("rename", "after", to);
  }

  delete(path: string): void {
    this.boundary("delete", "before", path);
    if (!this.files.delete(path)) throw new Error(`file not found: ${path}`);
    this.boundary("delete", "after", path);
  }

  persistState(body: Uint8Array): void {
    this.boundary("persist-state", "before", "state");
    this.state = copy(body);
    this.boundary("persist-state", "after", "state");
  }

  readState(): Uint8Array | undefined {
    return this.state && copy(this.state);
  }

  private boundary(operation: LocalFsOperation, phase: BoundaryPhase, path: string): void {
    this.hook?.(operation, phase, path);
  }
}

function copy(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}
