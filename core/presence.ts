export type LocalPresence = "present" | "confirmed-absent" | "unknown" | "out-of-scope";

export function mayCreateDeletionEvidence(presence: LocalPresence, auditComplete: boolean, scopeStable: boolean, directlyRechecked: boolean): boolean {
  return presence === "confirmed-absent" && auditComplete && scopeStable && directlyRechecked;
}
