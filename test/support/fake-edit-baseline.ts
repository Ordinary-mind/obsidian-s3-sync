export interface DirtyIntent {
  generation: number;
  basisHeads: string[];
  localPredecessorVersion: string | undefined;
  awaitingLocalWrite: boolean;
}

export class FakeEditBaseline {
  private readonly observedHeads = new Map<string, string[]>();
  private readonly projectedHeads = new Map<string, string[]>();
  private readonly intents = new Map<string, DirtyIntent>();
  private readonly frozenVersions = new Map<string, string>();
  private readonly publishedVersions = new Map<string, string>();

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
      awaitingLocalWrite: true,
    };
    this.intents.set(path, intent);
    return { ...intent, basisHeads: [...intent.basisHeads] };
  }

  freeze(path: string, versionId: string): void {
    const intent = this.intents.get(path);
    if (!intent) throw new Error(`cannot freeze without dirty intent: ${path}`);
    if (intent.awaitingLocalWrite) throw new Error(`cannot freeze before editor write is proven: ${path}`);
    this.frozenVersions.set(path, versionId);
    this.intents.delete(path);
  }

  proveEditorWrite(path: string, generation: number): void {
    const intent = this.intents.get(path);
    if (!intent || intent.generation !== generation) {
      throw new Error(`cannot prove an unknown editor generation: ${path}:${generation}`);
    }
    intent.awaitingLocalWrite = false;
  }

  nextGeneration(path: string): DirtyIntent {
    const predecessor = this.frozenVersions.get(path);
    if (!predecessor) throw new Error(`cannot create next generation without frozen version: ${path}`);
    const intent = {
      generation: 2,
      basisHeads: [],
      localPredecessorVersion: predecessor,
      awaitingLocalWrite: true,
    };
    this.intents.set(path, intent);
    return { ...intent, basisHeads: [] };
  }

  requestDeleteAfterRootPut(path: string): "waiting-for-root-publish" | DirtyIntent {
    const frozen = this.frozenVersions.get(path);
    if (!frozen || this.publishedVersions.get(path) !== frozen) return "waiting-for-root-publish";
    const intent = { generation: 2, basisHeads: [], localPredecessorVersion: frozen, awaitingLocalWrite: true };
    this.intents.set(path, intent);
    return { ...intent, basisHeads: [] };
  }

  confirmPublished(path: string, versionId: string): void {
    if (this.frozenVersions.get(path) !== versionId) {
      throw new Error(`cannot confirm an unfrozen version: ${versionId}`);
    }
    this.publishedVersions.set(path, versionId);
  }

  getObservedHeads(path: string): string[] {
    return [...(this.observedHeads.get(path) ?? [])];
  }
}
