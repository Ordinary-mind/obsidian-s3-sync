export type RepositoryHealth = "healthy" | "retrying-dependency" | "integrity-stopped" | "recovery-required";

export function deriveRepositoryHealth(input: { hasIntegrityFailure: boolean; hasRecoveryRequired: boolean; hasPendingDependencies: boolean }): RepositoryHealth {
  if (input.hasIntegrityFailure) return "integrity-stopped";
  if (input.hasRecoveryRequired) return "recovery-required";
  return input.hasPendingDependencies ? "retrying-dependency" : "healthy";
}
