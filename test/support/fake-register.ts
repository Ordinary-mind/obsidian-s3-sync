export interface FakeRegisterVersion {
  versionId: string;
  parents: string[];
}

// Test-only model for the set-based head rule; production state belongs to task 1.
export class FakeRegister {
  private readonly known = new Map<string, FakeRegisterVersion>();

  constructor(private readonly catalog: ReadonlyMap<string, FakeRegisterVersion>) {}

  deliver(versionId: string): void {
    const version = this.catalog.get(versionId);
    if (!version) throw new Error(`unknown version: ${versionId}`);
    this.known.set(versionId, version);
  }

  heads(): string[] {
    const superseded = new Set<string>();
    for (const version of this.known.values()) {
      if (version.parents.every((parent) => this.known.has(parent))) {
        for (const parent of version.parents) superseded.add(parent);
      }
    }
    return [...this.known.keys()].filter((versionId) => !superseded.has(versionId)).sort();
  }
}
