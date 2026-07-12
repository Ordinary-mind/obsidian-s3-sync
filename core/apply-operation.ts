import type { ApplyJournal } from "./apply-journal";

export function isOwnApplyEvent(journals: readonly ApplyJournal[], path: string, actualHash: string | undefined): boolean {
  return journals.some((journal) => journal.path === path && journal.targetHash === actualHash && (journal.state === "installed" || journal.state === "verified"));
}
