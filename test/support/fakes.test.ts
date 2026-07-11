import { describe, expect, it } from "vitest";

import { FakeCrash, FakeLocalFs } from "./fake-local-fs";
import {
  FakeObjectStore,
  ImmutableObjectExistsError,
  LostResponseError,
  ObjectNotFoundError,
} from "./fake-object-store";
import { FakeClock } from "./fake-clock";
import { FakeEditorEvents } from "./fake-editor-events";
import { FakeEditBaseline } from "./fake-edit-baseline";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("deterministic test fakes", () => {
  it("orders virtual-time callbacks deterministically and permits cancellation", () => {
    const clock = new FakeClock();
    const order: string[] = [];
    clock.schedule(10, () => order.push("late"));
    const cancelled = clock.schedule(5, () => order.push("cancelled"));
    clock.schedule(5, () => order.push("first"));
    clock.schedule(5, () => order.push("second"));
    clock.cancel(cancelled);
    clock.advance(5);
    expect(order).toEqual(["first", "second"]);
    expect(clock.now()).toBe(5);
    clock.advance(5);
    expect(order).toEqual(["first", "second", "late"]);
  });

  it("assigns monotonic per-path editor generations before any disk event", () => {
    const editor = new FakeEditorEvents();
    const received: string[] = [];
    editor.onChange((change) => received.push(`${change.path}:${change.generation}:${change.content}`));
    expect(editor.emit("notes/example.md", "first")).toMatchObject({ generation: 1 });
    expect(editor.emit("notes/other.md", "other")).toMatchObject({ generation: 1 });
    expect(editor.emit("notes/example.md", "second")).toMatchObject({ generation: 2 });
    expect(received).toEqual([
      "notes/example.md:1:first",
      "notes/other.md:1:other",
      "notes/example.md:2:second",
    ]);
  });

  it("keeps an editor dirty baseline immutable across later remote observations", () => {
    const baseline = new FakeEditBaseline();
    baseline.setProjectedHeads("notes/example.md", ["remote-before:0:0"]);
    const first = baseline.beginEdit("notes/example.md");
    baseline.observeHeads("notes/example.md", ["remote-before:0:0", "remote-after:0:0"]);
    expect(first.basisHeads).toEqual(["remote-before:0:0"]);
    expect(baseline.beginEdit("notes/example.md").basisHeads).toEqual(["remote-before:0:0"]);
    expect(baseline.getObservedHeads("notes/example.md")).toEqual([
      "remote-before:0:0",
      "remote-after:0:0",
    ]);

    baseline.freeze("notes/example.md", "local-frozen:0:0");
    baseline.observeHeads("notes/example.md", ["remote-after:0:0", "remote-later:0:0"]);
    expect(baseline.nextGeneration("notes/example.md")).toEqual({
      generation: 2,
      basisHeads: [],
      localPredecessorVersion: "local-frozen:0:0",
    });
  });

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

  it("models server-side immutable creation without a HEAD-then-PUT race", () => {
    const store = new FakeObjectStore();
    store.putImmutable("objects/same", encoder.encode("first"));
    expect(() => store.putImmutable("objects/same", encoder.encode("second"))).toThrow(
      ImmutableObjectExistsError,
    );
    expect(decoder.decode(store.get("objects/same"))).toBe("first");
  });
});
