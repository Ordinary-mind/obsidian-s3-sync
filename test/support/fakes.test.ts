import { describe, expect, it } from "vitest";

import { FakeCrash, FakeLocalFs } from "./fake-local-fs";
import { FakeObjectStore, LostResponseError, ObjectNotFoundError } from "./fake-object-store";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("deterministic test fakes", () => {
  it("injects local races and crashes at read, write, rename, delete and state boundaries", () => {
    const fs = new FakeLocalFs();
    const boundaries: string[] = [];
    fs.seed("before", encoder.encode("original"));
    fs.setBoundaryHook((operation, phase, path) => {
      boundaries.push(`${operation}:${phase}:${path}`);
      if (operation === "rename" && phase === "after") throw new FakeCrash();
    });

    expect(() => fs.rename("before", "recovery")).toThrow(FakeCrash);
    expect(decoder.decode(fs.read("recovery"))).toBe("original");
    fs.setBoundaryHook((operation, phase, path) => boundaries.push(`${operation}:${phase}:${path}`));
    fs.write("active", encoder.encode("next"));
    fs.delete("active");
    fs.persistState(encoder.encode("state"));
    expect(decoder.decode(fs.readState())).toBe("state");
    expect(boundaries).toEqual(expect.arrayContaining(["rename:after:recovery", "write:before:active", "delete:after:active", "persist-state:after:state"]));
  });

  it("models late visibility, list disorder, temporary 404, lost response and tampering", () => {
    const store = new FakeObjectStore();
    store.putImmutable("objects/a", encoder.encode("original"), { visibleAfter: 2 });
    expect(store.list("objects/")).toEqual([]);
    store.advance(2);
    store.injectTemporary404("objects/a");
    expect(() => store.get("objects/a")).toThrow(ObjectNotFoundError);
    expect(decoder.decode(store.get("objects/a"))).toBe("original");
    store.setListPages([[], ["objects/a", "objects/a", "objects/missing"]]);
    expect(store.list("objects/")).toEqual([]);
    expect(store.list("objects/")).toEqual(["objects/a", "objects/a", "objects/missing"]);
    store.tamper("objects/a", encoder.encode("corrupt"));
    expect(decoder.decode(store.get("objects/a"))).toBe("corrupt");
    expect(() => store.putImmutable("objects/lost", encoder.encode("stored"), { loseResponse: true })).toThrow(
      LostResponseError,
    );
    expect(decoder.decode(store.get("objects/lost"))).toBe("stored");
  });
});
