export interface DirtyIntent {
  generation: number;
  basisHeads: string[];
  localPredecessorVersion: string | undefined;
}

export class FakeEditBaseline {
  private readonly observedHeads = new Map<string, string[]>();
  private readonly projectedHeads = new Map<string, string[]>();
  private readonly intents = new Map<string, DirtyIntent>();
  private readonly frozenVersions = new Map<string, string>();

  setProjectedHeads(path: string, heads: string[]): void {
    this.projectedHeads.set(path, [...heads]);
  }

  observeHeads(path: string, heads: string[]): void {
    this.observedHeads.set(path, [...heads]);
  }

  beginEdit(path: string): DirtyIntent {
    const existing = this.intents.get(path);
    if (existing) return { ...existing, basisHeads: [...existing.basisHeads] };
    const predecessor = this.frozenVersions.get(path);
    const intent: DirtyIntent = {
      generation: 1,
      basisHeads: predecessor ? [] : [...(this.projectedHeads.get(path) ?? [])],
      localPredecessorVersion: predecessor,
    };
    this.intents.set(path, intent);
    return { ...intent, basisHeads: [...intent.basisHeads] };
  }

  freeze(path: string, versionId: string): void {
    if (!this.intents.has(path)) throw new Error(`cannot freeze without dirty intent: ${path}`);
    this.frozenVersions.set(path, versionId);
    this.intents.delete(path);
  }

  nextGeneration(path: string): DirtyIntent {
    const predecessor = this.frozenVersions.get(path);
    if (!predecessor) throw new Error(`cannot create next generation without frozen version: ${path}`);
    const intent = {
      generation: 2,
      basisHeads: [],
      localPredecessorVersion: predecessor,
    };
    this.intents.set(path, intent);
    return { ...intent, basisHeads: [] };
  }

  getObservedHeads(path: string): string[] {
    return [...(this.observedHeads.get(path) ?? [])];
  }
}
