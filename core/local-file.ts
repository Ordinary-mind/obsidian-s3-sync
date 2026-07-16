import type { ContentStagingAdapter } from "./content-staging";

export type LocalFileObservation =
  | { kind: "present"; hash: string; size: number }
  | { kind: "absent" }
  | { kind: "unknown"; reason: string };

export interface LocalFileCapabilities {
  platform: "windows" | "macos" | "linux";
  domain: "vault" | "config";
  renameToRecovery: boolean;
  noClobberInstall: boolean;
  recoveryObservation: boolean;
  eventsObservable: boolean;
  accessMethod: "node-fs";
  renameAtomicity: "link-unlink";
  overwritePolicy: "no-clobber" | "unsupported";
  occupiedFileBehavior: "preserve-and-error";
}

export type EmptyDirectoryRemoval = "removed" | "absent" | "not-directory" | "not-empty" | "unknown";

export interface LocalFileAdapter {
  readonly capabilities: LocalFileCapabilities;
  observe(path: string): Promise<LocalFileObservation>;
  observeRecovery(recoveryRef: string): Promise<LocalFileObservation>;
  moveToRecovery(path: string, recoveryRef: string): Promise<void>;
  installStagedNoClobber(stagedRef: string, path: string): Promise<boolean>;
  restoreRecoveryNoClobber(recoveryRef: string, path: string): Promise<boolean>;
  materializeConservativeCandidate(stagedRef: string, candidateRef: string): Promise<void>;
  removeEmptyDirectoryNoFollow(path: string): Promise<EmptyDirectoryRemoval>;
}

export interface LocalApplyAdapterContract {
  files: LocalFileAdapter;
  staging: ContentStagingAdapter;
}

export function canPerformDestructiveApply(capabilities: Pick<LocalFileCapabilities, "renameToRecovery" | "noClobberInstall" | "recoveryObservation" | "eventsObservable" | "overwritePolicy">): boolean {
  return capabilities.renameToRecovery && capabilities.noClobberInstall && capabilities.recoveryObservation
    && capabilities.eventsObservable && capabilities.overwritePolicy === "no-clobber";
}

export function localApplyMode(capabilities: Pick<LocalFileCapabilities, "renameToRecovery" | "noClobberInstall" | "recoveryObservation" | "eventsObservable" | "overwritePolicy">): "destructive" | "conservative" {
  return canPerformDestructiveApply(capabilities) ? "destructive" : "conservative";
}
