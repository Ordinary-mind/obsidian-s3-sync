import { describe, expect, it } from "vitest";
import { canPerformDestructiveApply } from "../../core/local-file";
describe("LocalFileAdapter safety capability", () => { it("refuses destructive apply unless recovery rename and no-clobber are both proven", () => {
  expect(canPerformDestructiveApply({ renameToRecovery: true, noClobberInstall: true, recoveryObservation: true })).toBe(true);
  expect(canPerformDestructiveApply({ renameToRecovery: true, noClobberInstall: false, recoveryObservation: true })).toBe(false);
  expect(canPerformDestructiveApply({ renameToRecovery: true, noClobberInstall: true, recoveryObservation: false })).toBe(false);
}); });
