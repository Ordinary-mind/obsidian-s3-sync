import { describe, expect, it } from "vitest";
import { advanceApplyJournal, verifyApplyAfterImage } from "../../core/apply-journal";
import { decideRecovery } from "../../core/recovery";
import { isOwnApplyEvent } from "../../core/apply-operation";

describe("ApplyJournal safety", () => {
  const journal = { operationId: "op", path: "notes/a.md", expectedBeforeHash: "before", targetHash: "target", state: "prepared" as const };
  it("requires persisted ordered phases before projection accounting", () => {
    const installed = advanceApplyJournal(journal, "installed");
    expect(verifyApplyAfterImage(installed, "target").state).toBe("verified");
    expect(advanceApplyJournal(verifyApplyAfterImage(installed, "target"), "accounted").state).toBe("accounted");
    expect(verifyApplyAfterImage(installed, "wrong").state).toBe("recovery-required");
  });
  it("keeps a concurrent active edit instead of moving it during recovery", () => {
    expect(decideRecovery("new-edit", "before", "before")).toBe("keep-active-and-recover");
    expect(decideRecovery("before", "before", "before")).toBe("continue-apply");
  });
  it("recognizes only matching Journal post-images as its own file event", () => {
    const installed = advanceApplyJournal(journal, "installed");
    expect(isOwnApplyEvent([journal], "notes/a.md", "target")).toBe(true);
    expect(isOwnApplyEvent([installed], "notes/a.md", "target")).toBe(true);
    expect(isOwnApplyEvent([installed], "notes/a.md", "external")).toBe(false);
    expect(isOwnApplyEvent([{ ...installed, state: "recovery-required" }], "notes/a.md", "target")).toBe(false);
  });
});
