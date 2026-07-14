import {
  planVaultOnboarding,
  type LocalOnboardingFile,
  type RemoteOnboardingRegister,
  type VaultOnboardingPlan,
} from "./vault-onboarding";

export type ReattachDecision = "rebuild-empty-local" | "require-non-destructive-onboarding";

export interface StateLossRecoveryPlan {
  entrypoint: "non-destructive-onboarding";
  strategy: ReattachDecision;
  onboarding: VaultOnboardingPlan;
  pendingRecoveryFiles: string[];
  autoSyncDisabled: true;
  projectionConfirmationRequired: true;
  publicationAuthorized: false;
  destructiveApplyAuthorized: false;
}

export function decideStateLossRecovery(localHasContent: boolean): ReattachDecision {
  return localHasContent ? "require-non-destructive-onboarding" : "rebuild-empty-local";
}

export function planStateLossRecovery(input: {
  localFiles: readonly LocalOnboardingFile[];
  remoteRegisters: readonly RemoteOnboardingRegister[];
  pendingRecoveryFiles?: readonly string[];
}): StateLossRecoveryPlan {
  const pendingRecoveryFiles = [...new Set(input.pendingRecoveryFiles ?? [])].sort();
  return {
    entrypoint: "non-destructive-onboarding",
    strategy: decideStateLossRecovery(input.localFiles.length > 0 || pendingRecoveryFiles.length > 0),
    onboarding: planVaultOnboarding(input.localFiles, input.remoteRegisters),
    pendingRecoveryFiles,
    autoSyncDisabled: true,
    projectionConfirmationRequired: true,
    publicationAuthorized: false,
    destructiveApplyAuthorized: false,
  };
}
