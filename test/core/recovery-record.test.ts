import { describe, expect, it } from "vitest";
import {
  createRecoveryRecord,
  markRecoveryCleaned,
  observeRecoveryContent,
  requestRecoveryCleanup,
} from "../../core/recovery-record";

describe("recovery record", () => {
  const originalHash = "a".repeat(64);

  it("keeps post-capture edits reachable and requires review of the latest stable bytes", () => {
    const original = createRecoveryRecord({
      id: "recovery-1",
      contentRef: "state/recovery/1",
      logicalPath: "notes/a.md",
      source: "apply-before-image",
      hash: originalHash,
      size: 3,
      capturedAt: 1,
    });
    const edited = observeRecoveryContent(original, { kind: "present", hash: "b".repeat(64), size: 4 });
    expect(edited).toMatchObject({ postCaptureEdit: true, cleanupState: "retained", lastStableSize: 4 });
    expect(() => requestRecoveryCleanup(edited, { explicit: true, reviewedHash: originalHash, reviewedSize: 3 })).toThrow("changed after user review");
    const requested = requestRecoveryCleanup(edited, { explicit: true, reviewedHash: "b".repeat(64), reviewedSize: 4 });
    expect(() => markRecoveryCleaned(requested, false)).toThrow("still reachable");
    expect(markRecoveryCleaned(requested, true).cleanupState).toBe("cleaned");
  });

  it("never treats an unknown or missing observation as permission to clean", () => {
    const record = createRecoveryRecord({ id: "r", contentRef: "state/r", logicalPath: "a", source: "local-concurrent", hash: originalHash, size: 0, capturedAt: 0 });
    expect(observeRecoveryContent(record, { kind: "unknown" }).cleanupState).toBe("retained");
    expect(observeRecoveryContent({ ...record, cleanupState: "cleanup-requested" }, { kind: "missing" }).cleanupState).toBe("retained");
  });
});
