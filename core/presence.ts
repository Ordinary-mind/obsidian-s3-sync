export type LocalPresence = "present" | "confirmed-absent" | "unknown" | "out-of-scope";

export interface DeletionEvidence {
  path: string;
  scopeRevision: string;
  confirmedAt: number;
}

export function mayCreateDeletionEvidence(presence: LocalPresence, auditComplete: boolean, scopeStable: boolean, directlyRechecked: boolean): boolean {
  return presence === "confirmed-absent" && auditComplete && scopeStable && directlyRechecked;
}

export function createDeletionEvidence(path: string, scopeRevision: string, confirmedAt: number, presence: LocalPresence, auditComplete: boolean, scopeStable: boolean, directlyRechecked: boolean): DeletionEvidence | undefined {
  return mayCreateDeletionEvidence(presence, auditComplete, scopeStable, directlyRechecked) ? Object.freeze({ path, scopeRevision, confirmedAt }) : undefined;
}
