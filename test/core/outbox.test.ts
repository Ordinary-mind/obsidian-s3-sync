import { describe, expect, it } from "vitest";
import { freezeOutboxBytes, replayOutboxBytes } from "../../core/outbox";

describe("immutable Outbox bytes", () => {
  it("copies frozen Commit bytes and replays a fresh exact copy", () => {
    const source = new Uint8Array([1, 2]);
    const entry = freezeOutboxBytes("commit", source);
    source[0] = 9;
    const replay = replayOutboxBytes(entry);
    replay[1] = 8;
    expect([...entry.bytes]).toEqual([1, 2]);
  });
});
