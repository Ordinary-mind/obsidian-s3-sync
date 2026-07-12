import { describe, expect, it } from "vitest";
import { assertSequenceNotReused, freezeOutboxBytes, nextPublishableOutbox, replayOutboxBytes } from "../../core/outbox";

describe("immutable Outbox bytes", () => {
  it("copies frozen Commit bytes and replays a fresh exact copy", () => {
    const source = new Uint8Array([1, 2]);
    const entry = freezeOutboxBytes("commit", source);
    source[0] = 9;
    const replay = replayOutboxBytes(entry);
    replay[1] = 8;
    expect([...entry.bytes]).toEqual([1, 2]);
  });
  it("publishes each writer FIFO and never reuses an allocated sequence", () => {
    const entries = [
      { ...freezeOutboxBytes("two", new Uint8Array([2])), writerId: "writer", sequence: "00000000000000000002" },
      { ...freezeOutboxBytes("one", new Uint8Array([1])), writerId: "writer", sequence: "00000000000000000001" },
    ];
    expect(nextPublishableOutbox(entries, "writer")?.id).toBe("one");
    expect(() => assertSequenceNotReused(entries, { ...entries[0], id: "replacement", bytes: new Uint8Array([9]) })).toThrow("sequence already");
  });
});
