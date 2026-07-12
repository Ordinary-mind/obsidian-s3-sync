export interface WriterCommit {
  sequence: string;
  hash: string;
  previousCommitHash: string | null;
}

export type WriterChainIssue = "sequence-gap" | "previous-mismatch" | "sequence-fork";

export function inspectWriterChain(commits: readonly WriterCommit[]): WriterChainIssue[] {
  const bySequence = new Map<string, WriterCommit[]>();
  for (const commit of commits) bySequence.set(commit.sequence, [...(bySequence.get(commit.sequence) ?? []), commit]);
  const sequences = [...bySequence.keys()].sort();
  const issues = new Set<WriterChainIssue>();
  sequences.forEach((sequence, index) => {
    const entries = bySequence.get(sequence)!;
    if (new Set(entries.map((entry) => entry.hash)).size > 1) issues.add("sequence-fork");
    if (sequence !== (index + 1).toString().padStart(20, "0")) issues.add("sequence-gap");
    const previous = index === 0 ? new Set<string>() : new Set(bySequence.get(sequences[index - 1])!.map((entry) => entry.hash));
    for (const entry of entries) {
      if ((sequence === "00000000000000000001" && entry.previousCommitHash !== null) || (sequence !== "00000000000000000001" && (entry.previousCommitHash === null || !previous.has(entry.previousCommitHash)))) issues.add("previous-mismatch");
    }
  });
  return [...issues].sort();
}
