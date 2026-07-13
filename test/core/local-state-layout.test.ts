import { describe, expect, it } from "vitest";
import { decideResidualStateHandling, repositoryStateLayout } from "../../core/local-state-layout";

describe("repository state layout", () => {
  it("places all operational and recovery data below the owned repository root", () => {
    const layout = repositoryStateLayout("settings", "123e4567-e89b-42d3-a456-426614174000");
    for (const path of [layout.owner, ...layout.stateCopies, layout.staged, layout.outbox, layout.journals, layout.recovery, layout.conflictDrafts]) {
      expect(path.startsWith(`${layout.root}/`)).toBe(true);
    }
  });

  it("resumes residual owned state after reinstall and requires reattachment for nonempty state loss", () => {
    expect(decideResidualStateHandling({ stateRoot: "owned", durableState: "valid", localHasContent: true })).toBe("resume-existing-state");
    expect(decideResidualStateHandling({ stateRoot: "owned", durableState: "corrupt", localHasContent: true })).toBe("reattach-required");
    expect(decideResidualStateHandling({ stateRoot: "foreign", durableState: "missing", localHasContent: false })).toBe("refuse-foreign-root");
  });
});
