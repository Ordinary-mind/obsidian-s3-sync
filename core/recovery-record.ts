export type RecoverySource =
  | "apply-before-image"
  | "config-rollback"
  | "conflict-draft"
  | "local-concurrent"
  | "post-capture-edit"
  | "state-loss-onboarding";

export interface RecoveryRecord {
  id: string;
  contentRef: string;
  logicalPath: string;
  source: RecoverySource;
  capturedHash: string;
  capturedSize: number;
  lastStableHash: string;
  lastStableSize: number;
  capturedAt: number;
  postCaptureEdit: boolean;
  cleanupState: "retained" | "cleanup-requested" | "cleaned";
}

export interface RecoveryContentObservation {
  kind: "present" | "unknown" | "missing";
  hash?: string;
  size?: number;
}

export function createRecoveryRecord(input: {
  id: string;
  contentRef: string;
  logicalPath: string;
  source: RecoverySource;
  hash: string;
  size: number;
  capturedAt: number;
}): RecoveryRecord {
  assertNonEmpty(input.id, "recovery id");
  assertNonEmpty(input.contentRef, "recovery content reference");
  assertNonEmpty(input.logicalPath, "recovery logical path");
  assertHash(input.hash);
  assertSize(input.size);
  if (!Number.isSafeInteger(input.capturedAt) || input.capturedAt < 0) throw new Error("recovery capture time is invalid");
  return {
    id: input.id,
    contentRef: input.contentRef,
    logicalPath: input.logicalPath,
    source: input.source,
    capturedHash: input.hash,
    capturedSize: input.size,
    lastStableHash: input.hash,
    lastStableSize: input.size,
    capturedAt: input.capturedAt,
    postCaptureEdit: false,
    cleanupState: "retained",
  };
}

export function observeRecoveryContent(record: RecoveryRecord, observation: RecoveryContentObservation): RecoveryRecord {
  if (observation.kind !== "present") return { ...record, cleanupState: "retained" };
  if (observation.hash === undefined || observation.size === undefined) throw new Error("present recovery observation needs hash and size");
  assertHash(observation.hash);
  assertSize(observation.size);
  const changed = observation.hash !== record.capturedHash || observation.size !== record.capturedSize;
  return {
    ...record,
    lastStableHash: observation.hash,
    lastStableSize: observation.size,
    postCaptureEdit: record.postCaptureEdit || changed,
    cleanupState: "retained",
  };
}

export function requestRecoveryCleanup(
  record: RecoveryRecord,
  confirmation: { explicit: true; reviewedHash: string; reviewedSize: number },
): RecoveryRecord {
  if (confirmation.explicit !== true) throw new Error("recovery cleanup requires explicit confirmation");
  assertHash(confirmation.reviewedHash);
  assertSize(confirmation.reviewedSize);
  if (confirmation.reviewedHash !== record.lastStableHash || confirmation.reviewedSize !== record.lastStableSize) {
    throw new Error("recovery content changed after user review");
  }
  return { ...record, cleanupState: "cleanup-requested" };
}

export function markRecoveryCleaned(record: RecoveryRecord, observedAbsent: boolean): RecoveryRecord {
  if (record.cleanupState !== "cleanup-requested") throw new Error("recovery cleanup was not explicitly requested");
  if (!observedAbsent) throw new Error("recovery content is still reachable");
  return { ...record, cleanupState: "cleaned" };
}

function assertNonEmpty(value: string, name: string): void {
  if (value.length === 0) throw new Error(`${name} is invalid`);
}

function assertHash(hash: string): void {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("recovery content hash is invalid");
}

function assertSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("recovery content size is invalid");
}
