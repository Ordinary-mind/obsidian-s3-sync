export type RecoveryDecision = "keep-active-and-recover" | "continue-apply" | "stop-recovery-required";

export function decideRecovery(activeHash: string | undefined, expectedBeforeHash: string | undefined, recoveredHash: string | undefined): RecoveryDecision {
  if (activeHash !== expectedBeforeHash && activeHash !== undefined) return "keep-active-and-recover";
  if (recoveredHash === undefined) return "stop-recovery-required";
  return "continue-apply";
}
