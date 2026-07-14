import type {
  EmptyDirectoryRemoval,
  LocalFileAdapter,
  LocalFileCapabilities,
  LocalFileObservation,
} from "../core/local-file";

export interface ObsidianLocalFilePort {
  observe(path: string): Promise<LocalFileObservation>;
  observeRecovery(recoveryRef: string): Promise<LocalFileObservation>;
  moveToRecovery(path: string, recoveryRef: string): Promise<void>;
  installStagedNoClobber(stagedRef: string, path: string): Promise<boolean>;
  restoreRecoveryNoClobber(recoveryRef: string, path: string): Promise<boolean>;
  materializeConservativeCandidate(stagedRef: string, candidateRef: string): Promise<void>;
  removeEmptyDirectoryNoFollow(path: string): Promise<EmptyDirectoryRemoval>;
}

export interface ObsidianAdapterVerification {
  renameToRecovery: boolean;
  noClobberInstall: boolean;
  recoveryObservation: boolean;
  eventsObservable: boolean;
  renameAtomicity: "atomic" | "link-unlink" | "unsupported";
  occupiedFileBehavior: "preserve-and-error" | "unknown";
}

export class ObsidianLocalFileAdapter implements LocalFileAdapter {
  readonly capabilities: LocalFileCapabilities;

  constructor(
    private readonly port: ObsidianLocalFilePort,
    input: {
      platform: "windows" | "macos" | "linux" | "mobile" | "unknown";
      domain: "vault" | "config";
      verification: ObsidianAdapterVerification;
    },
  ) {
    this.capabilities = {
      platform: input.platform,
      domain: input.domain,
      ...input.verification,
      accessMethod: input.domain === "vault" ? "obsidian-vault-api" : "obsidian-adapter",
      overwritePolicy: input.verification.noClobberInstall ? "no-clobber" : "unsupported",
    };
  }

  observe(path: string): Promise<LocalFileObservation> { return this.port.observe(path); }
  observeRecovery(recoveryRef: string): Promise<LocalFileObservation> { return this.port.observeRecovery(recoveryRef); }

  async moveToRecovery(path: string, recoveryRef: string): Promise<void> {
    this.assertDestructiveCapability("renameToRecovery");
    await this.port.moveToRecovery(path, recoveryRef);
  }

  async installStagedNoClobber(stagedRef: string, path: string): Promise<boolean> {
    this.assertDestructiveCapability("noClobberInstall");
    return this.port.installStagedNoClobber(stagedRef, path);
  }

  async restoreRecoveryNoClobber(recoveryRef: string, path: string): Promise<boolean> {
    this.assertDestructiveCapability("noClobberInstall");
    return this.port.restoreRecoveryNoClobber(recoveryRef, path);
  }

  materializeConservativeCandidate(stagedRef: string, candidateRef: string): Promise<void> {
    return this.port.materializeConservativeCandidate(stagedRef, candidateRef);
  }

  async removeEmptyDirectoryNoFollow(path: string): Promise<EmptyDirectoryRemoval> {
    this.assertDestructiveCapability("renameToRecovery");
    return this.port.removeEmptyDirectoryNoFollow(path);
  }

  private assertDestructiveCapability(capability: "renameToRecovery" | "noClobberInstall"): void {
    if (!this.capabilities[capability]) throw new Error(`Obsidian ${this.capabilities.domain} adapter lacks verified ${capability}`);
  }
}
