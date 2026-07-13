export interface EditorLatch {
  generation: number;
  expectedContentHash: string;
  awaitingLocalWrite: boolean;
}

export interface EditorLocalCandidate {
  kind: "put" | "delete";
  hash?: string;
}

export interface EditorDirtyIntent extends EditorLatch {
  path: string;
  editorGeneration: number;
  basisHeads: string[];
  projectedValueHash: string | undefined;
  localCandidates: EditorLocalCandidate[];
}

export function captureEditorChange(input: {
  path: string;
  projectedHeads: readonly string[];
  projectedValueHash: string | undefined;
  editorContentHash: string;
  existing?: EditorDirtyIntent;
}): EditorDirtyIntent {
  if (input.existing && input.existing.path !== input.path) throw new Error("editor intent path mismatch");
  if (input.existing) {
    return {
      ...input.existing,
      generation: input.existing.generation + 1,
      editorGeneration: input.existing.editorGeneration + 1,
      expectedContentHash: input.editorContentHash,
      basisHeads: [...input.existing.basisHeads],
      localCandidates: input.existing.localCandidates.map(copyCandidate),
      awaitingLocalWrite: true,
    };
  }
  return {
    path: input.path,
    generation: 1,
    editorGeneration: 1,
    expectedContentHash: input.editorContentHash,
    basisHeads: [...new Set(input.projectedHeads)].sort(),
    projectedValueHash: input.projectedValueHash,
    localCandidates: [],
    awaitingLocalWrite: true,
  };
}

export function observeEditorDisk(
  intent: EditorDirtyIntent,
  candidate: EditorLocalCandidate,
  sourceProvesExternalChange: boolean,
): { intent: EditorDirtyIntent; decision: "keep-waiting" | "editor-write-proven" | "local-concurrent" } {
  const candidateKey = `${candidate.kind}:${candidate.hash ?? ""}`;
  const candidates = intent.localCandidates.some((value) => `${value.kind}:${value.hash ?? ""}` === candidateKey)
    ? intent.localCandidates.map(copyCandidate)
    : [...intent.localCandidates.map(copyCandidate), copyCandidate(candidate)];
  if (candidate.kind === "put" && candidate.hash === intent.expectedContentHash) {
    return { intent: { ...intent, localCandidates: candidates, awaitingLocalWrite: false }, decision: "editor-write-proven" };
  }
  if (candidate.kind === "put" && candidate.hash === intent.projectedValueHash) {
    return { intent: { ...intent, localCandidates: intent.localCandidates.map(copyCandidate) }, decision: "keep-waiting" };
  }
  return {
    intent: { ...intent, localCandidates: candidates },
    decision: sourceProvesExternalChange ? "local-concurrent" : "keep-waiting",
  };
}

export function mayApplyRemoteWithEditorIntent(intent: EditorDirtyIntent | undefined): boolean {
  return intent === undefined;
}

export function observeStableDisk(latch: EditorLatch, diskHash: string, sourceProvesExternalChange: boolean): "keep-waiting" | "editor-write-proven" | "local-concurrent" {
  if (!latch.awaitingLocalWrite) return "editor-write-proven";
  if (diskHash === latch.expectedContentHash) return "editor-write-proven";
  return sourceProvesExternalChange ? "local-concurrent" : "keep-waiting";
}

function copyCandidate(candidate: EditorLocalCandidate): EditorLocalCandidate {
  return { ...candidate };
}
