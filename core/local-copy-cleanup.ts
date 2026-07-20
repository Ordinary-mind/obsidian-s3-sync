import type { RecoveryRecord } from "./recovery-record";

export interface LocalCopyCleanupSelection {
  eligible: RecoveryRecord[];
  protected: RecoveryRecord[];
}

export function selectCleanableRecoveryRecords(input: {
  records: readonly RecoveryRecord[];
  applyJournals: readonly { operationId: string; path: string }[];
  conflicts: readonly { path: string; resolved: boolean }[];
}): LocalCopyCleanupSelection {
  const activeOperationIds = new Set(input.applyJournals.map((journal) => journal.operationId));
  const activeApplyPaths = new Set(input.applyJournals.map((journal) => journal.path));
  const activeRecoveryRefs = new Set(input.applyJournals.map((journal) => `recovery/${journal.operationId}`));
  const unresolvedPaths = new Set(input.conflicts
    .filter((conflict) => !conflict.resolved)
    .map((conflict) => conflict.path));
  const retained = input.records.filter((record) => record.cleanupState !== "cleaned");
  const protectedRefs = new Set(retained
    .filter((record) => record.source !== "apply-before-image"
      || record.postCaptureEdit
      || activeOperationIds.has(record.id)
      || activeApplyPaths.has(record.logicalPath)
      || activeRecoveryRefs.has(record.contentRef)
      || unresolvedPaths.has(record.logicalPath))
    .map((record) => record.contentRef));
  const eligible: RecoveryRecord[] = [];
  const protectedRecords: RecoveryRecord[] = [];

  for (const record of retained) {
    const safeToClean = record.source === "apply-before-image"
      && !record.postCaptureEdit
      && !activeOperationIds.has(record.id)
      && !activeApplyPaths.has(record.logicalPath)
      && !activeRecoveryRefs.has(record.contentRef)
      && !unresolvedPaths.has(record.logicalPath)
      && !protectedRefs.has(record.contentRef);
    (safeToClean ? eligible : protectedRecords).push(record);
  }
  return { eligible, protected: protectedRecords };
}
