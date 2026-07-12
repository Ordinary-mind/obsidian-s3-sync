import { describe, expect, it } from "vitest";
import { canApplyRegisterState, classifyRegisterState } from "../../core/conflict-state";

describe("register conflict state", () => {
  it("blocks automatic apply for concurrent, pending and invalid states", () => {
    expect(classifyRegisterState(["a", "b"], [], [])).toBe("concurrent");
    expect(classifyRegisterState([], ["pending"], [])).toBe("pending");
    expect(classifyRegisterState(["a"], [], ["invalid"])).toBe("invalid");
    expect(canApplyRegisterState("resolved")).toBe(true);
    expect(canApplyRegisterState("concurrent")).toBe(false);
  });
});
