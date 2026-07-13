import { advanceWriterFrontiers, type CommitFrontierAnchor, type WriterFrontiers } from "./commit-frontier";

export interface IngestedCommitState {
  frontiers: WriterFrontiers;
  sparseSeenCommits: Record<string, CommitFrontierAnchor>;
}

export function advanceIngestedCommitState(
  current: IngestedCommitState,
  commits: readonly CommitFrontierAnchor[],
): IngestedCommitState {
  const candidates = new Map<string, CommitFrontierAnchor>();
  for (const commit of [...Object.values(current.sparseSeenCommits), ...commits]) candidates.set(commit.hash, { ...commit });
  const connected: CommitFrontierAnchor[] = [];
  const known = new Map<string, CommitFrontierAnchor>();
  for (const anchor of Object.values(current.frontiers).flat()) known.set(anchor.hash, anchor);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [hash, commit] of candidates) {
      const parent = commit.previousCommitHash === null ? undefined : known.get(commit.previousCommitHash);
      const isRoot = commit.sequence === "00000000000000000001" && commit.previousCommitHash === null;
      const followsKnown = !!parent && parent.writerId === commit.writerId && BigInt(commit.sequence) === BigInt(parent.sequence) + 1n;
      if (!isRoot && !followsKnown) continue;
      connected.push(commit);
      known.set(hash, commit);
      candidates.delete(hash);
      changed = true;
    }
  }
  return {
    frontiers: connected.length > 0 ? advanceWriterFrontiers(current.frontiers, connected) : cloneFrontiers(current.frontiers),
    sparseSeenCommits: Object.fromEntries([...candidates].sort(([left], [right]) => left.localeCompare(right)).map(([hash, commit]) => [hash, { ...commit }])),
  };
}

function cloneFrontiers(frontiers: WriterFrontiers): WriterFrontiers {
  return Object.fromEntries(Object.entries(frontiers).map(([writerId, anchors]) => [writerId, anchors.map((anchor) => ({ ...anchor }))]));
}
