import { describe, expect, it } from "vitest";
import { captureEditorChange, createEditorLocalConcurrentRecord, mayApplyRemoteWithEditorIntent, observeEditorDisk, observeStableDisk } from "../../core/editor-latch";
describe("editor write latch", () => { it("does not guess external concurrency from a mismatched disk value", () => {
  const latch = { generation: 1, expectedContentHash: "editor", awaitingLocalWrite: true };
  expect(observeStableDisk(latch, "old-projection", false)).toBe("keep-waiting");
  expect(observeStableDisk(latch, "editor", false)).toBe("editor-write-proven");
  expect(observeStableDisk(latch, "external", true)).toBe("local-concurrent");
});
it("freezes projected heads across later editor generations", () => {
  const first = captureEditorChange({ path: "notes/a.md", projectedHeads: ["before"], projectedValueHash: "old", editorContentHash: "edit-1" });
  expect(mayApplyRemoteWithEditorIntent(first)).toBe(false);
  expect(mayApplyRemoteWithEditorIntent(undefined)).toBe(true);
  const second = captureEditorChange({ path: "notes/a.md", projectedHeads: ["before", "remote"], projectedValueHash: "remote", editorContentHash: "edit-2", existing: first });
  expect(second).toMatchObject({ generation: 2, editorGeneration: 2, basisHeads: ["before"], expectedContentHash: "edit-2", awaitingLocalWrite: true });
});
it("keeps the old projection waiting and records other disk candidates without guessing", () => {
  const intent = captureEditorChange({ path: "notes/a.md", projectedHeads: ["before"], projectedValueHash: "old", editorContentHash: "editor" });
  const oldDisk = observeEditorDisk(intent, { kind: "put", hash: "old" }, false);
  expect(oldDisk).toMatchObject({ decision: "keep-waiting", intent: { localCandidates: [], awaitingLocalWrite: true } });
  const unknown = observeEditorDisk(oldDisk.intent, { kind: "put", hash: "other" }, false);
  expect(unknown).toMatchObject({ decision: "keep-waiting", intent: { localCandidates: [{ kind: "put", hash: "other" }], awaitingLocalWrite: true } });
  expect(observeEditorDisk(unknown.intent, { kind: "put", hash: "other" }, true).decision).toBe("local-concurrent");
  expect(observeEditorDisk(unknown.intent, { kind: "put", hash: "editor" }, false)).toMatchObject({ decision: "editor-write-proven", intent: { awaitingLocalWrite: false } });
});
it("recognizes an earlier editor generation as autosave without clearing the latest latch", () => {
  const first = captureEditorChange({ path: "notes/a.md", projectedHeads: ["before"], projectedValueHash: "old", editorContentHash: "edit-1" });
  const latest = captureEditorChange({ path: "notes/a.md", projectedHeads: ["remote"], projectedValueHash: "remote", editorContentHash: "edit-2", existing: first });
  expect(observeEditorDisk(latest, { kind: "put", hash: "edit-1" }, false)).toMatchObject({
    decision: "editor-autosave",
    intent: { awaitingLocalWrite: true, basisHeads: ["before"] },
  });
});
it("requires explicit source evidence before creating local concurrency", () => {
  const intent = captureEditorChange({ path: "notes/a.md", projectedHeads: ["before"], projectedValueHash: "old", editorContentHash: "editor" });
  const deletion = { kind: "delete" as const };
  expect(observeEditorDisk(intent, deletion, false).decision).toBe("keep-waiting");
  expect(observeEditorDisk(intent, deletion, true).decision).toBe("local-concurrent");
  expect(() => createEditorLocalConcurrentRecord({ intent, externalCandidate: deletion })).toThrow("source evidence");
  expect(createEditorLocalConcurrentRecord({ intent, externalCandidate: deletion, sourceEvidenceId: "adapter:event-1" })).toMatchObject({
    path: "notes/a.md",
    basisHeads: ["before"],
    externalCandidate: deletion,
  });
});
it("survives persistence reload and repeated old disk observations", () => {
  let intent = JSON.parse(JSON.stringify(captureEditorChange({
    path: "notes/a.md",
    projectedHeads: ["before"],
    projectedValueHash: "old",
    editorContentHash: "editor",
  })));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const observation = observeEditorDisk(intent, { kind: "put", hash: "old" }, false);
    expect(observation.decision).toBe("keep-waiting");
    intent = observation.intent;
  }
  expect(intent).toMatchObject({ basisHeads: ["before"], awaitingLocalWrite: true, localCandidates: [] });
}); });
