import { describe, expect, it } from "vitest";
import { advanceApplyJournal, verifyApplyAfterImage } from "../../core/apply-journal";
import { isOwnApplyEvent } from "../../core/apply-operation";
import type { SafeApplyJournal } from "../../core/safe-apply";

describe("ApplyJournal safety", () => {
  const journal = { operationId: "op", path: "notes/a.md", expectedBeforeHash: "before", targetHash: "target", state: "prepared" as const };
  it("requires persisted ordered phases before projection accounting", () => {
    const installed = advanceApplyJournal(journal, "installed");
    expect(verifyApplyAfterImage(installed, "target").state).toBe("verified");
    expect(advanceApplyJournal(verifyApplyAfterImage(installed, "target"), "accounted").state).toBe("accounted");
    expect(verifyApplyAfterImage(installed, "wrong").state).toBe("recovery-required");
  });
  it("recognizes only matching Journal post-images as its own file event", () => {
    const installed = advanceApplyJournal(journal, "installed");
    expect(isOwnApplyEvent([journal], undefined, "notes/a.md", "target")).toBe(false);
    expect(isOwnApplyEvent([journal], "other", "notes/a.md", "target")).toBe(false);
    expect(isOwnApplyEvent([journal], "op", "notes/a.md", "target")).toBe(true);
    expect(isOwnApplyEvent([installed], "op", "notes/a.md", "target")).toBe(true);
    expect(isOwnApplyEvent([installed], "op", "notes/a.md", "external")).toBe(false);
    expect(isOwnApplyEvent([{ ...installed, state: "recovery-required" }], "op", "notes/a.md", "target")).toBe(false);
  });
  it("recognizes the temporary removal while a safe put moves its before-image", () => {
    const safePut: SafeApplyJournal = {
      operationId: "safe-put",
      path: "notes/a.md",
      repositoryFingerprint: "fingerprint",
      targetHeads: ["remote"],
      projectedHeads: ["projected"],
      target: { kind: "put", hash: "target", size: 1, stagedRef: "staged/target" },
      expectedLocal: { kind: "present", hash: "before", size: 1 },
      projectionGeneration: 1,
      dirtyGeneration: 1,
      state: "prepared",
    };
    expect(isOwnApplyEvent([safePut], safePut.operationId, safePut.path, undefined)).toBe(true);
    expect(isOwnApplyEvent([{ ...safePut, state: "recovery-moved" }], safePut.operationId, safePut.path, undefined)).toBe(true);
    expect(isOwnApplyEvent([{ ...safePut, state: "installed" }], safePut.operationId, safePut.path, undefined)).toBe(false);
  });
});
