import { describe, expect, it } from "vitest";
import { captureStableBytes } from "../../core/stable-capture";

describe("stable byte capture", () => {
  it("returns an immutable first read only when the second full read matches", async () => {
    const original = new Uint8Array([1, 2]);
    const result = await captureStableBytes(async () => ({ type: "file" as const, bytes: original }));
    original[0] = 9;
    expect(result?.bytes).toEqual(new Uint8Array([1, 2]));
    expect(result?.size).toBe(2);
  });

  it("does not capture changed, missing or non-file paths", async () => {
    let calls = 0;
    await expect(captureStableBytes(async () => (++calls === 1 ? { type: "file" as const, bytes: new Uint8Array([1]) } : { type: "file" as const, bytes: new Uint8Array([2]) }))).resolves.toBeUndefined();
    await expect(captureStableBytes(async () => ({ type: "missing" as const }))).resolves.toBeUndefined();
  });
});
