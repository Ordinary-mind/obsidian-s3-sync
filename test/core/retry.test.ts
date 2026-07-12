import { describe, expect, it } from "vitest";
import { classifyImmutablePutConflict, classifyObjectReadFailure } from "../../core/retry";

describe("immutable object retry classification", () => {
  it("retries only same-byte immutable conflicts", () => {
    expect(classifyImmutablePutConflict("same", "same")).toBe("retry");
    expect(classifyImmutablePutConflict("other", "same")).toBe("integrity-error");
    expect(classifyObjectReadFailure("auth")).toBe("stop");
  });
});
