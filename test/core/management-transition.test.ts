import { describe, expect, it } from "vitest";
import { decideManagementTransition } from "../../core/management-transition";

describe("management scope transitions", () => {
  it("stops management without creating a tombstone", () => {
    expect(decideManagementTransition({ wasManaged: true, isManaged: false, presence: "confirmed-absent", contentChanged: false, hasDeletionEvidence: true })).toBe("stop-managing");
    expect(decideManagementTransition({ wasManaged: true, isManaged: false, presence: "present", contentChanged: true, hasDeletionEvidence: false })).toBe("stop-managing");
  });

  it("requires confirmed deletion evidence only while the path remains managed", () => {
    expect(decideManagementTransition({ wasManaged: true, isManaged: true, presence: "confirmed-absent", contentChanged: false, hasDeletionEvidence: true })).toBe("publish-delete");
    expect(decideManagementTransition({ wasManaged: true, isManaged: true, presence: "confirmed-absent", contentChanged: false, hasDeletionEvidence: false })).toBe("retry");
    expect(decideManagementTransition({ wasManaged: true, isManaged: true, presence: "unknown", contentChanged: false, hasDeletionEvidence: false })).toBe("retry");
  });
});
