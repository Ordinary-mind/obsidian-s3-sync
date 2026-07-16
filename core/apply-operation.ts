import type { ApplyJournal } from "./apply-journal";
import type { SafeApplyJournal } from "./safe-apply";

export function isOwnApplyEvent(
  journals: readonly (ApplyJournal | SafeApplyJournal)[],
  operationId: string | undefined,
  path: string,
  actualHash: string | undefined,
): boolean {
  if (!operationId) return false;
  return journals.some((journal) => {
    const targetHash = "target" in journal
      ? journal.target.kind === "put" ? journal.target.hash : undefined
      : journal.targetHash;
    return journal.operationId === operationId && journal.path === path
      && targetHash === actualHash
      && ["prepared", "recovery-moved", "installed", "verified"].includes(journal.state);
  });
}
