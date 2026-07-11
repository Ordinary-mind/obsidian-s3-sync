import { describe, expect, it } from "vitest";

import { FakeCrash, FakeLocalFs } from "./fake-local-fs";
import {
  FakeObjectStore,
  ImmutableObjectExistsError,
  ImmutableObjectIntegrityError,
  LostResponseError,
  ObjectNotFoundError,
} from "./fake-object-store";
import { FakeClock } from "./fake-clock";
import { FakeEditorEvents } from "./fake-editor-events";
import { FakeEditBaseline } from "./fake-edit-baseline";
import { FakeOutbox } from "./fake-outbox";
import { FakePublisher } from "./fake-publisher";

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

    baseline.proveEditorWrite("notes/example.md", 1);
    baseline.freeze("notes/example.md", "local-frozen:0:0");
    baseline.observeHeads("notes/example.md", ["remote-after:0:0", "remote-later:0:0"]);
    expect(baseline.nextGeneration("notes/example.md")).toEqual({
      generation: 2,
      basisHeads: [],
      localPredecessorVersion: "local-frozen:0:0",
      awaitingLocalWrite: true,
    });
  });

  it("does not freeze a root delete before the frozen root put is verified published", () => {
    const baseline = new FakeEditBaseline();
    baseline.beginEdit("notes/new.md");
    baseline.proveEditorWrite("notes/new.md", 1);
    baseline.freeze("notes/new.md", "root-put:0:0");
    expect(baseline.requestDeleteAfterRootPut("notes/new.md")).toBe("waiting-for-root-publish");
    baseline.confirmPublished("notes/new.md", "root-put:0:0");
    expect(baseline.requestDeleteAfterRootPut("notes/new.md")).toEqual({
      generation: 2,
      basisHeads: [],
      localPredecessorVersion: "root-put:0:0",
      awaitingLocalWrite: true,
    });
  });

  it("does not clear an editor write latch merely because remote state advances", () => {
    const baseline = new FakeEditBaseline();
    baseline.setProjectedHeads("notes/latch.md", ["before:0:0"]);
    const intent = baseline.beginEdit("notes/latch.md");
    baseline.observeHeads("notes/latch.md", ["before:0:0", "after:0:0"]);
    expect(() => baseline.freeze("notes/latch.md", "frozen:0:0")).toThrow(
      "cannot freeze before editor write is proven",
    );
    baseline.proveEditorWrite("notes/latch.md", intent.generation);
    expect(() => baseline.freeze("notes/latch.md", "frozen:0:0")).not.toThrow();
  });

  it("stores frozen outbox bytes by value for exact retry after active content changes", () => {
    const outbox = new FakeOutbox();
    const activeBytes = encoder.encode("frozen commit");
    outbox.freeze("commit-1", activeBytes);
    activeBytes[0] = "X".charCodeAt(0);
    expect(decoder.decode(outbox.replay("commit-1"))).toBe("frozen commit");
    expect(() => outbox.freeze("commit-1", encoder.encode("replacement"))).toThrow(
      "outbox entry is immutable",
    );
  });

  it("keeps Commit publication last after immutable dependencies", () => {
    const publisher = new FakePublisher();
    publisher.publish("blob");
    publisher.publish("config-tree");
    publisher.publish("change-chunk");
    publisher.publish("commit");
    expect(publisher.stages).toEqual(["blob", "config-tree", "change-chunk", "commit"]);
    expect(() => new FakePublisher().publish("commit")).toThrow("publish stage out of order");
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

  it("keeps a renamed recovery file observable when an old handle writes after rename", () => {
    const fs = new FakeLocalFs();
    fs.seed("active", encoder.encode("before"));
    const handle = fs.open("active");
    fs.rename("active", "recovery");
    fs.writeHandle(handle, encoder.encode("post-capture edit"));
    expect(decoder.decode(fs.read("recovery"))).toBe("post-capture edit");
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

  it("treats an immutable create conflict as idempotent only after exact body verification", () => {
    const store = new FakeObjectStore();
    store.putImmutableIdempotent("objects/same", encoder.encode("body"));
    expect(() => store.putImmutableIdempotent("objects/same", encoder.encode("body"))).not.toThrow();
    expect(() => store.putImmutableIdempotent("objects/same", encoder.encode("other"))).toThrow(
      ImmutableObjectIntegrityError,
    );
    store.tamper("objects/same", encoder.encode("corrupt"));
    expect(() => store.putImmutableIdempotent("objects/same", encoder.encode("body"))).toThrow(
      ImmutableObjectIntegrityError,
    );
  });

  it("recovers a lost immutable PUT response by retrying the same frozen bytes", () => {
    const store = new FakeObjectStore();
    expect(() => store.putImmutable("objects/lost-retry", encoder.encode("frozen"), { loseResponse: true })).toThrow(
      LostResponseError,
    );
    expect(() => store.putImmutableIdempotent("objects/lost-retry", encoder.encode("frozen"))).not.toThrow();
    expect(decoder.decode(store.get("objects/lost-retry"))).toBe("frozen");
  });
});
