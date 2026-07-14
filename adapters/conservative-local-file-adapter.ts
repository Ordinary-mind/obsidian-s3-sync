import type { LocalFileAdapter, LocalFileCapabilities, LocalFileObservation } from "../core/local-file";

export interface ConservativeLocalFilePort {
  observe(path: string): Promise<LocalFileObservation>;
  writeCandidateNoClobber(stagedRef: string, candidateRef: string): Promise<void>;
}

export class ConservativeLocalFileAdapter implements LocalFileAdapter {
  readonly capabilities: LocalFileCapabilities;

  constructor(
    private readonly port: ConservativeLocalFilePort,
    input: { platform: "mobile" | "unknown"; domain: "vault" | "config"; eventsObservable: boolean },
  ) {
    this.capabilities = {
      ...input,
      renameToRecovery: false,
      noClobberInstall: false,
      recoveryObservation: false,
      accessMethod: "conservative-port",
      renameAtomicity: "unsupported",
      overwritePolicy: "unsupported",
      occupiedFileBehavior: "unknown",
    };
  }

  observe(path: string): Promise<LocalFileObservation> { return this.port.observe(path); }
  observeRecovery(path: string): Promise<LocalFileObservation> { return this.port.observe(path); }
  async moveToRecovery(_path: string, _recoveryRef: string): Promise<void> { throw new Error("conservative adapter does not move formal paths"); }
  async installStagedNoClobber(_stagedRef: string, _path: string): Promise<boolean> { throw new Error("conservative adapter does not install formal paths"); }
  async restoreRecoveryNoClobber(_recoveryRef: string, _path: string): Promise<boolean> { throw new Error("conservative adapter does not restore formal paths"); }
  materializeConservativeCandidate(stagedRef: string, candidateRef: string): Promise<void> {
    return this.port.writeCandidateNoClobber(stagedRef, candidateRef);
  }
  async removeEmptyDirectoryNoFollow(_path: string): Promise<"unknown"> { return "unknown"; }
}
