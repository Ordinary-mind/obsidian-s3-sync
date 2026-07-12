export interface EditorLatch {
  generation: number;
  expectedContentHash: string;
  awaitingLocalWrite: boolean;
}

export function observeStableDisk(latch: EditorLatch, diskHash: string, sourceProvesExternalChange: boolean): "keep-waiting" | "editor-write-proven" | "local-concurrent" {
  if (!latch.awaitingLocalWrite) return "editor-write-proven";
  if (diskHash === latch.expectedContentHash) return "editor-write-proven";
  return sourceProvesExternalChange ? "local-concurrent" : "keep-waiting";
}
