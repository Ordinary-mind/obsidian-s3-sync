import { nextSequence } from "./sequence";

export interface WriterSession {
  writerId: string;
  nextSequence: string;
  previousCommitHash: string | null;
}

export function reserveWriterCommit(session: WriterSession): { sequence: string; previousCommitHash: string | null } {
  return { sequence: session.nextSequence, previousCommitHash: session.previousCommitHash };
}

export function recordPublishedWriterCommit(session: WriterSession, commitHash: string): WriterSession {
  if (!/^[0-9a-f]{64}$/.test(commitHash)) throw new Error("published Commit hash must be SHA-256");
  return { ...session, nextSequence: nextSequence(session.nextSequence), previousCommitHash: commitHash };
}
