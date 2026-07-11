import { describe, expect, it } from "vitest";
import { captureDirtyIntent, mergeDirtyEdit, nextDirtyGeneration, proveEditorWrite } from "../../core/dirty-record";

describe("core dirty intent causality", () => {
  it("freezes projected heads and never accepts later observed heads", () => {
    const first = captureDirtyIntent("notes/a.md", ["before"]);
    expect(mergeDirtyEdit(first)).toMatchObject({ generation: 2, basisHeads: ["before"], awaitingLocalWrite: true });
  });
  it("uses an exact frozen local predecessor for later generations", () => {
    expect(nextDirtyGeneration("notes/a.md", 2, "local:0:0")).toEqual({ path: "notes/a.md", generation: 2, basisHeads: [], localPredecessorVersion: "local:0:0", awaitingLocalWrite: true });
  });
  it("does not clear the write latch for a different editor generation", () => {
    expect(() => proveEditorWrite(captureDirtyIntent("notes/a.md", []), 2)).toThrow("editor generation");
    expect(proveEditorWrite(captureDirtyIntent("notes/a.md", []), 1).awaitingLocalWrite).toBe(false);
  });
});
