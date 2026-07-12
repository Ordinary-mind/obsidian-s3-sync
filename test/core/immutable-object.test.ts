import { describe, expect, it } from "vitest";
import { verifyImmutableObject } from "../../core/immutable-object";

describe("immutable protocol object", () => {
  it("treats exact retries as success and different bytes as integrity errors", () => {
    const object = { key: "objects/a", hash: "a", bytes: new Uint8Array([1]) };
    expect(verifyImmutableObject(object, { ...object, bytes: new Uint8Array([1]) })).toBe("already-present");
    expect(() => verifyImmutableObject(object, { ...object, bytes: new Uint8Array([2]) })).toThrow("collision");
  });
});
