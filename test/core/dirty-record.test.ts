import { describe, expect, it } from "vitest";
import { captureDirtyIntent, freezeOutboxVersion, mergeDirtyEdit, nextDirtyGeneration, proveEditorWrite } from "../../core/dirty-record";

describe("core dirty intent causality", () => {
  it("freezes projected heads and never accepts later observed heads", () => {
    const first = captureDirtyIntent("notes/a.md", ["before"]);
    expect(mergeDirtyEdit(first)).toMatchObject({ generation: 2, basisHeads: ["before"], awaitingLocalWrite: true });
  });
  it("uses an exact frozen local predecessor for later generations", () => {
    expect(nextDirtyGeneration("notes/a.md", 2, { path: "notes/a.md", queueId: "notes/a.md", versionId: "local:0:0" })).toMatchObject({ path: "notes/a.md", localPredecessorVersion: "local:0:0", basisHeads: [] });
    expect(() => nextDirtyGeneration("notes/a.md", 2, { path: "notes/b.md", queueId: "notes/b.md", versionId: "remote:0:0" })).toThrow("same path queue");
  });
  it("does not clear the write latch for a different editor generation", () => {
    expect(() => proveEditorWrite(captureDirtyIntent("notes/a.md", []), 2)).toThrow("editor generation");
    expect(proveEditorWrite(captureDirtyIntent("notes/a.md", []), 1).awaitingLocalWrite).toBe(false);
  });
  it("only creates a predecessor from a write-proven immutable Outbox version", () => {
    const dirty = captureDirtyIntent("notes/a.md", []);
    expect(() => freezeOutboxVersion(dirty, "local:0:0")).toThrow("editor write");
    const frozen = freezeOutboxVersion(proveEditorWrite(dirty, 1), "local:0:0");
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(nextDirtyGeneration("notes/a.md", 2, frozen).localPredecessorVersion).toBe("local:0:0");
  });
});
