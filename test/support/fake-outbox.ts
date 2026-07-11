export class FakeOutbox {
  private readonly entries = new Map<string, Uint8Array>();

  freeze(id: string, bytes: Uint8Array): void {
    if (this.entries.has(id)) throw new Error(`outbox entry is immutable: ${id}`);
    this.entries.set(id, new Uint8Array(bytes));
  }

  replay(id: string): Uint8Array {
    const bytes = this.entries.get(id);
    if (!bytes) throw new Error(`missing outbox entry: ${id}`);
    return new Uint8Array(bytes);
  }
}
