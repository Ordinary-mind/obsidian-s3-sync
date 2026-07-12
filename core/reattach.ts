export type ReattachDecision = "rebuild-empty-local" | "require-non-destructive-onboarding";

export function decideStateLossRecovery(localHasContent: boolean): ReattachDecision {
  return localHasContent ? "require-non-destructive-onboarding" : "rebuild-empty-local";
}
