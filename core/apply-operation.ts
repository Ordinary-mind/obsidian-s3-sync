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
    const intermediatePutRemoval = "target" in journal && journal.target.kind === "put"
      && actualHash === undefined && ["prepared", "recovery-moved"].includes(journal.state);
    return journal.operationId === operationId && journal.path === path
      && (targetHash === actualHash || intermediatePutRemoval)
      && ["prepared", "recovery-moved", "installed", "verified"].includes(journal.state);
  });
}

export function isOwnApplyEditorEvent(
  journals: readonly (ApplyJournal | SafeApplyJournal)[],
  operationId: string | undefined,
  path: string,
  contentHash: string,
): boolean {
  if (isOwnApplyEvent(journals, operationId, path, contentHash)) return true;
  if (!operationId) return false;
  return journals.some((journal) => "target" in journal
    && journal.operationId === operationId
    && journal.path === path
    && journal.expectedLocal.kind === "present"
    && journal.expectedLocal.hash === contentHash
    && ["prepared", "recovery-moved"].includes(journal.state));
}
