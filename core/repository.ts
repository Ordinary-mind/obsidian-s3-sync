import { classifyRegisterState, type RegisterDisposition } from "./conflict-state";
import { reduceRegister, type RegisterState, type RegisterVersion } from "./register";
import { captureConflictResolution, type ConflictResolutionIntent } from "./resolution";

export interface RepositoryRegisterSnapshot extends RegisterState {
  disposition: RegisterDisposition;
}

export class InMemoryRepositoryCore {
  private readonly versions: RegisterVersion[] = [];

  ingest(version: RegisterVersion): void {
    this.versions.push({ ...version, parents: [...version.parents] });
  }

  snapshotVersions(): RegisterVersion[] {
    return this.versions.map((version) => ({ ...version, parents: [...version.parents] }));
  }

  restoreVersions(versions: readonly RegisterVersion[]): void {
    this.versions.length = 0;
    for (const version of versions) this.ingest(version);
  }

  register(repositoryId: string, channel: "vault" | "config", logicalKey: string): RepositoryRegisterSnapshot {
    const state = reduceRegister(this.versions.filter((version) => version.repositoryId === repositoryId && version.channel === channel && version.logicalKey === logicalKey));
    return { ...state, disposition: classifyRegisterState(state.heads, state.pending, state.invalid) };
  }

  allRegisters(repositoryId: string): Map<string, RepositoryRegisterSnapshot> {
    const keys = new Set(this.versions.filter((version) => version.repositoryId === repositoryId).map((version) => `${version.channel}:${version.logicalKey}`));
    return new Map([...keys].map((key) => {
      const [channel, ...rest] = key.split(":");
      const logicalKey = rest.join(":");
      return [key, this.register(repositoryId, channel as "vault" | "config", logicalKey)];
    }));
  }

  beginResolution(repositoryId: string, channel: "vault" | "config", logicalKey: string, selectedValueHash: string): ConflictResolutionIntent {
    const snapshot = this.register(repositoryId, channel, logicalKey);
    if (snapshot.disposition !== "concurrent") throw new Error("resolution requires concurrent register heads");
    return captureConflictResolution(logicalKey, snapshot.heads, selectedValueHash);
  }
}
