import type { ApplyJournal } from "./apply-journal";

export function isOwnApplyEvent(
  journals: readonly ApplyJournal[],
  operationId: string | undefined,
  path: string,
  actualHash: string | undefined,
): boolean {
  if (!operationId) return false;
  return journals.some((journal) => journal.operationId === operationId && journal.path === path
    && journal.targetHash === actualHash
    && ["prepared", "recovery-moved", "installed", "verified"].includes(journal.state));
}
