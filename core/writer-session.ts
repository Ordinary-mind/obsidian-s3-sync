import { isMaximumSequence, nextSequence } from "./sequence";

export interface WriterSession {
  writerId: string;
  nextSequence: string;
  previousCommitHash: string | null;
}

export function reserveWriterCommit(session: WriterSession): { sequence: string; previousCommitHash: string | null } {
  return { sequence: session.nextSequence, previousCommitHash: session.previousCommitHash };
}

export function recordPublishedWriterCommit(
  session: WriterSession,
  commitHash: string,
  createWriterId?: () => string,
): WriterSession {
  if (!/^[0-9a-f]{64}$/.test(commitHash)) throw new Error("published Commit hash must be SHA-256");
  if (!isMaximumSequence(session.nextSequence)) {
    return { ...session, nextSequence: nextSequence(session.nextSequence), previousCommitHash: commitHash };
  }
  if (!createWriterId) throw new Error("writer rotation is required after maximum sequence");
  return replacementWriter(session, createWriterId());
}

export function rotateWriterAfterFork(
  session: WriterSession,
  nextWriterId: string,
  outboxDrained: boolean,
): WriterSession {
  if (!outboxDrained) throw new Error("writer fork rotation requires a drained Outbox");
  return replacementWriter(session, nextWriterId);
}

function replacementWriter(session: WriterSession, nextWriterId: string): WriterSession {
  if (nextWriterId.length === 0 || nextWriterId === session.writerId) throw new Error("replacement writerId must be new");
  return { writerId: nextWriterId, nextSequence: "00000000000000000001", previousCommitHash: null };
}
