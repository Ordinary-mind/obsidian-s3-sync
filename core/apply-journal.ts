export type ApplyJournalState = "prepared" | "recovery-moved" | "installed" | "verified" | "accounted" | "recovery-required";

export interface ApplyJournal {
  operationId: string;
  path: string;
  expectedBeforeHash: string | undefined;
  targetHash: string | undefined;
  state: ApplyJournalState;
}

const transitions: Record<ApplyJournalState, ApplyJournalState[]> = {
  prepared: ["recovery-moved", "installed", "recovery-required"],
  "recovery-moved": ["installed", "recovery-required"],
  installed: ["verified", "recovery-required"],
  verified: ["accounted", "recovery-required"],
  accounted: [],
  "recovery-required": [],
};

export function advanceApplyJournal(journal: ApplyJournal, state: ApplyJournalState): ApplyJournal {
  if (!transitions[journal.state].includes(state)) throw new Error(`invalid ApplyJournal transition: ${journal.state} -> ${state}`);
  return { ...journal, state };
}

export function verifyApplyAfterImage(journal: ApplyJournal, actualHash: string | undefined): ApplyJournal {
  if (journal.state !== "installed") throw new Error("ApplyJournal must be installed before after-image verification");
  return actualHash === journal.targetHash ? advanceApplyJournal(journal, "verified") : { ...journal, state: "recovery-required" };
}
