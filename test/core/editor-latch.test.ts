import { describe, expect, it } from "vitest";
import { captureEditorChange, mayApplyRemoteWithEditorIntent, observeEditorDisk, observeStableDisk } from "../../core/editor-latch";
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
