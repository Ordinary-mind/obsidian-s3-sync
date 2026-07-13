export type LocalFileObservation =
  | { kind: "present"; hash: string; size: number }
  | { kind: "absent" }
  | { kind: "unknown"; reason: string };

export interface LocalFileCapabilities {
  platform: "windows" | "macos" | "linux" | "mobile" | "unknown";
  domain: "vault" | "config";
  renameToRecovery: boolean;
  noClobberInstall: boolean;
  recoveryObservation: boolean;
  eventsObservable: boolean;
}

export interface LocalFileAdapter {
  readonly capabilities: LocalFileCapabilities;
  observe(path: string): Promise<LocalFileObservation>;
  observeRecovery(recoveryRef: string): Promise<LocalFileObservation>;
  moveToRecovery(path: string, recoveryRef: string): Promise<void>;
  installStagedNoClobber(stagedRef: string, path: string): Promise<boolean>;
  restoreRecoveryNoClobber(recoveryRef: string, path: string): Promise<boolean>;
  materializeConservativeCandidate(stagedRef: string, candidateRef: string): Promise<void>;
}

export function canPerformDestructiveApply(capabilities: Pick<LocalFileCapabilities, "renameToRecovery" | "noClobberInstall" | "recoveryObservation">): boolean {
  return capabilities.renameToRecovery && capabilities.noClobberInstall && capabilities.recoveryObservation;
}

export function localApplyMode(capabilities: Pick<LocalFileCapabilities, "renameToRecovery" | "noClobberInstall" | "recoveryObservation">): "destructive" | "conservative" {
  return canPerformDestructiveApply(capabilities) ? "destructive" : "conservative";
}
