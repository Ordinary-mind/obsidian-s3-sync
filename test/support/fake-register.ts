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
    const verified = this.verifiedVersions();
    const superseded = new Set<string>();
    for (const version of verified.values()) {
      for (const parent of version.parents) superseded.add(parent);
    }
    return [...verified.keys()].filter((versionId) => !superseded.has(versionId)).sort();
  }

  private verifiedVersions(): Map<string, FakeRegisterVersion> {
    const verified = new Map<string, FakeRegisterVersion>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const [versionId, version] of this.known) {
        if (!verified.has(versionId) && version.parents.every((parent) => verified.has(parent))) {
          verified.set(versionId, version);
          changed = true;
        }
      }
    }
    return verified;
  }
}
