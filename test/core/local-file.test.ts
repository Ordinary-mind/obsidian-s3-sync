import { describe, expect, it } from "vitest";
import { canPerformDestructiveApply } from "../../core/local-file";
describe("LocalFileAdapter safety capability", () => { it("refuses destructive apply unless recovery rename and no-clobber are both proven", () => {
  const base = { renameToRecovery: true, noClobberInstall: true, recoveryObservation: true, eventsObservable: true, overwritePolicy: "no-clobber" as const };
  expect(canPerformDestructiveApply(base)).toBe(true);
  expect(canPerformDestructiveApply({ ...base, noClobberInstall: false })).toBe(false);
  expect(canPerformDestructiveApply({ ...base, recoveryObservation: false })).toBe(false);
  expect(canPerformDestructiveApply({ ...base, eventsObservable: false })).toBe(false);
}); });
