import { sha256Hex } from "../protocol/hash";
import type { LocalFileAdapter, LocalFileObservation } from "./local-file";
import { localApplyMode } from "./local-file";
import { createRecoveryRecord, observeRecoveryContent, type RecoveryRecord } from "./recovery-record";

export type ApplyTarget =
  | { kind: "put"; hash: string; size: number; stagedRef: string }
  | { kind: "delete" };

export interface BoundApplyPlan {
  operationId: string;
  path: string;
  repositoryFingerprint: string;
  targetHeads: string[];
  target: ApplyTarget;
  expectedLocal: { kind: "present"; hash: string; size: number } | { kind: "absent" };
  projectionGeneration: number;
  dirtyGeneration: number;
  groupId?: string;
}

export type SafeApplyJournalState =
  | "prepared"
  | "recovery-moved"
  | "installed"
  | "verified"
  | "accounted"
  | "recovery-required";

export interface SafeApplyJournal extends BoundApplyPlan {
  state: SafeApplyJournalState;
  recoveryRef?: string;
  recoveryRecord?: RecoveryRecord;
  verifiedAfter?: { kind: "present"; hash: string; size: number } | { kind: "absent" };
}

export interface ApplyGuardState {
  repositoryFingerprint: string;
  observedHeads: string[];
  projectionGeneration: number;
  dirtyGeneration: number;
  hasDirtyIntent: boolean;
  hasLocalConcurrentRecord: boolean;
}

export interface SafeApplyStateStore {
  guard(path: string): Promise<ApplyGuardState>;
  persistJournal(journal: SafeApplyJournal): Promise<void>;
  persistRecovery(record: RecoveryRecord): Promise<void>;
  freezeLocalChange(path: string, observed: LocalFileObservation, basisHeads: readonly string[]): Promise<void>;
  accountProjection(plan: BoundApplyPlan, after: Exclude<LocalFileObservation, { kind: "unknown" }>): Promise<void>;
}

export interface SafeApplyOptions {
  now(): number;
  recoveryRef(plan: BoundApplyPlan): string;
  conservativeCandidateRef(plan: BoundApplyPlan): string;
  verifyStaged(target: Extract<ApplyTarget, { kind: "put" }>): Promise<void>;
}

export type SafeApplyResult =
  | { status: "accounted"; journal: SafeApplyJournal }
  | { status: "adopted-without-write"; journal: SafeApplyJournal }
  | { status: "conservative-candidate"; candidateRef: string }
  | { status: "stale-plan" | "local-change-frozen" | "pending" | "recovery-required"; journal?: SafeApplyJournal };

export class SafeLocalApplicator {
  constructor(
    private readonly files: LocalFileAdapter,
    private readonly state: SafeApplyStateStore,
    private readonly options: SafeApplyOptions,
  ) {}

  async apply(plan: BoundApplyPlan): Promise<SafeApplyResult> {
    validatePlan(plan);
    const guard = await this.state.guard(plan.path);
    if (!guardMatches(plan, guard)) return { status: "stale-plan" };
    const before = await this.files.observe(plan.path);
    if (before.kind === "unknown") return { status: "pending" };
    if (!observationMatchesExpected(before, plan.expectedLocal)) {
      await this.state.freezeLocalChange(plan.path, before, plan.targetHeads);
      return { status: "local-change-frozen" };
    }
    if (observationMatchesTarget(before, plan.target)) {
      return this.adoptWithoutWrite(plan, before);
    }
    if (plan.target.kind === "put") await this.options.verifyStaged(plan.target);
    if (localApplyMode(this.files.capabilities) === "conservative") {
      if (plan.target.kind === "put") {
        const candidateRef = this.options.conservativeCandidateRef(plan);
        await this.files.materializeConservativeCandidate(plan.target.stagedRef, candidateRef);
        return { status: "conservative-candidate", candidateRef };
      }
      return { status: "pending" };
    }

    let journal: SafeApplyJournal = { ...copyPlan(plan), state: "prepared" };
    await this.state.persistJournal(journal);
    if (!(await this.guardBeforeIo(plan))) return this.failJournal(journal, "stale-plan");

    if (before.kind === "present") {
      const recoveryRef = this.options.recoveryRef(plan);
      await this.files.moveToRecovery(plan.path, recoveryRef);
      const recovered = await this.files.observeRecovery(recoveryRef);
      if (recovered.kind !== "present" || recovered.hash !== before.hash || recovered.size !== before.size) {
        return this.failJournal({ ...journal, recoveryRef }, "recovery-required");
      }
      const recoveryRecord = createRecoveryRecord({
        id: plan.operationId,
        contentRef: recoveryRef,
        logicalPath: plan.path,
        source: "apply-before-image",
        hash: recovered.hash,
        size: recovered.size,
        capturedAt: this.options.now(),
      });
      await this.state.persistRecovery(recoveryRecord);
      journal = { ...journal, state: "recovery-moved", recoveryRef, recoveryRecord };
      await this.state.persistJournal(journal);
    }

    if (!(await this.guardBeforeIo(plan))) return this.failJournal(journal, "stale-plan");
    if (plan.target.kind === "put") {
      const installed = await this.files.installStagedNoClobber(plan.target.stagedRef, plan.path);
      if (!installed) {
        const active = await this.files.observe(plan.path);
        if (active.kind !== "unknown") await this.state.freezeLocalChange(plan.path, active, plan.targetHeads);
        return this.failJournal(journal, "local-change-frozen");
      }
    }
    journal = { ...journal, state: "installed" };
    await this.state.persistJournal(journal);

    const after = await this.files.observe(plan.path);
    if (after.kind === "unknown" || !observationMatchesTarget(after, plan.target)) {
      return this.failJournal(journal, "recovery-required");
    }
    journal = { ...journal, state: "verified", verifiedAfter: after };
    await this.state.persistJournal(journal);

    // rename 后旧句柄仍可能继续写恢复文件；这不会替代正式路径的独立后像守卫。
    if (journal.recoveryRef && journal.recoveryRecord) {
      const recovered = await this.files.observeRecovery(journal.recoveryRef);
      if (recovered.kind === "present") {
        const updated = observeRecoveryContent(journal.recoveryRecord, recovered);
        if (updated.postCaptureEdit !== journal.recoveryRecord.postCaptureEdit
          || updated.lastStableHash !== journal.recoveryRecord.lastStableHash
          || updated.lastStableSize !== journal.recoveryRecord.lastStableSize) {
          await this.state.persistRecovery(updated);
          journal = { ...journal, recoveryRecord: updated };
          await this.state.persistJournal(journal);
        }
      }
    }

    const finalGuard = await this.state.guard(plan.path);
    const finalAfter = await this.files.observe(plan.path);
    if (!guardMatches(plan, finalGuard) || finalAfter.kind === "unknown" || !observationMatchesTarget(finalAfter, plan.target)) {
      return this.failJournal(journal, "recovery-required");
    }
    await this.state.accountProjection(plan, finalAfter);
    journal = { ...journal, state: "accounted", verifiedAfter: finalAfter };
    await this.state.persistJournal(journal);
    return { status: "accounted", journal };
  }

  async resume(journal: SafeApplyJournal): Promise<SafeApplyResult> {
    if (journal.state === "accounted") return { status: "accounted", journal };
    if (journal.state === "recovery-required") return { status: "recovery-required", journal };
    const plan = copyPlan(journal);
    if (!guardMatches(plan, await this.state.guard(plan.path))) return this.failJournal(journal, "stale-plan");
    const active = await this.files.observe(plan.path);
    if (active.kind === "unknown") return { status: "pending", journal };

    if (observationMatchesTarget(active, plan.target)) {
      return this.verifyAndAccountResumed(journal, active);
    }
    if (journal.state === "prepared" && observationMatchesExpected(active, plan.expectedLocal)) {
      return this.apply(plan);
    }

    const recoveryRef = journal.recoveryRef ?? this.options.recoveryRef(plan);
    const recovered = await this.files.observeRecovery(recoveryRef);
    if (plan.expectedLocal.kind === "present"
      && recovered.kind === "present"
      && recovered.hash === plan.expectedLocal.hash
      && recovered.size === plan.expectedLocal.size
      && active.kind === "absent") {
      let recoveryRecord = journal.recoveryRecord ?? createRecoveryRecord({
        id: plan.operationId,
        contentRef: recoveryRef,
        logicalPath: plan.path,
        source: "apply-before-image",
        hash: recovered.hash,
        size: recovered.size,
        capturedAt: this.options.now(),
      });
      await this.state.persistRecovery(recoveryRecord);
      let resumed: SafeApplyJournal = { ...journal, recoveryRef, recoveryRecord, state: "recovery-moved" };
      await this.state.persistJournal(resumed);
      if (plan.target.kind === "put") {
        await this.options.verifyStaged(plan.target);
        if (!(await this.guardBeforeIo(plan))) return this.failJournal(resumed, "stale-plan");
        if (!(await this.files.installStagedNoClobber(plan.target.stagedRef, plan.path))) {
          const concurrent = await this.files.observe(plan.path);
          if (concurrent.kind !== "unknown") await this.state.freezeLocalChange(plan.path, concurrent, plan.targetHeads);
          return this.failJournal(resumed, "local-change-frozen");
        }
      }
      resumed = { ...resumed, state: "installed" };
      await this.state.persistJournal(resumed);
      const after = await this.files.observe(plan.path);
      if (after.kind === "unknown" || !observationMatchesTarget(after, plan.target)) return this.failJournal(resumed, "recovery-required");
      return this.verifyAndAccountResumed(resumed, after);
    }

    if (plan.expectedLocal.kind === "absent" && active.kind === "absent") {
      if (plan.target.kind === "delete") return this.verifyAndAccountResumed(journal, active);
      await this.options.verifyStaged(plan.target);
      if (!(await this.files.installStagedNoClobber(plan.target.stagedRef, plan.path))) return this.failJournal(journal, "local-change-frozen");
      const after = await this.files.observe(plan.path);
      if (after.kind === "unknown" || !observationMatchesTarget(after, plan.target)) return this.failJournal(journal, "recovery-required");
      return this.verifyAndAccountResumed({ ...journal, state: "installed" }, after);
    }
    await this.state.freezeLocalChange(plan.path, active, plan.targetHeads);
    return this.failJournal(journal, "local-change-frozen");
  }

  private async adoptWithoutWrite(
    plan: BoundApplyPlan,
    observation: Exclude<LocalFileObservation, { kind: "unknown" }>,
  ): Promise<SafeApplyResult> {
    let journal: SafeApplyJournal = { ...copyPlan(plan), state: "verified", verifiedAfter: observation };
    await this.state.persistJournal(journal);
    const finalGuard = await this.state.guard(plan.path);
    const final = await this.files.observe(plan.path);
    if (!guardMatches(plan, finalGuard) || final.kind === "unknown" || !observationMatchesTarget(final, plan.target)) {
      return this.failJournal(journal, "stale-plan");
    }
    await this.state.accountProjection(plan, final);
    journal = { ...journal, state: "accounted", verifiedAfter: final };
    await this.state.persistJournal(journal);
    return { status: "adopted-without-write", journal };
  }

  private async verifyAndAccountResumed(
    journal: SafeApplyJournal,
    after: Exclude<LocalFileObservation, { kind: "unknown" }>,
  ): Promise<SafeApplyResult> {
    const plan = copyPlan(journal);
    let verified: SafeApplyJournal = { ...journal, state: "verified", verifiedAfter: after };
    await this.state.persistJournal(verified);
    if (verified.recoveryRef && verified.recoveryRecord) {
      const recovery = await this.files.observeRecovery(verified.recoveryRef);
      if (recovery.kind === "present") {
        const updated = observeRecoveryContent(verified.recoveryRecord, recovery);
        await this.state.persistRecovery(updated);
        verified = { ...verified, recoveryRecord: updated };
        await this.state.persistJournal(verified);
      }
    }
    const final = await this.files.observe(plan.path);
    if (!guardMatches(plan, await this.state.guard(plan.path)) || final.kind === "unknown" || !observationMatchesTarget(final, plan.target)) {
      return this.failJournal(verified, "recovery-required");
    }
    await this.state.accountProjection(plan, final);
    const accounted: SafeApplyJournal = { ...verified, state: "accounted", verifiedAfter: final };
    await this.state.persistJournal(accounted);
    return { status: "accounted", journal: accounted };
  }

  private async guardBeforeIo(plan: BoundApplyPlan): Promise<boolean> {
    return guardMatches(plan, await this.state.guard(plan.path));
  }

  private async failJournal(
    journal: SafeApplyJournal,
    status: "stale-plan" | "local-change-frozen" | "recovery-required",
  ): Promise<SafeApplyResult> {
    const failed = { ...journal, state: "recovery-required" as const };
    await this.state.persistJournal(failed);
    return { status, journal: failed };
  }
}

export interface ApplyEventExpectation {
  operationId: string;
  path: string;
  target: { kind: "present"; hash: string } | { kind: "absent" };
  consumed: boolean;
}

export function consumeOwnApplyEvent(
  expectation: ApplyEventExpectation,
  event: { path: string; observation: LocalFileObservation },
): { ownEvent: boolean; expectation: ApplyEventExpectation } {
  if (expectation.consumed || event.path !== expectation.path || event.observation.kind === "unknown") {
    return { ownEvent: false, expectation };
  }
  const matches = expectation.target.kind === "absent"
    ? event.observation.kind === "absent"
    : event.observation.kind === "present" && event.observation.hash === expectation.target.hash;
  return matches
    ? { ownEvent: true, expectation: { ...expectation, consumed: true } }
    : { ownEvent: false, expectation };
}

export function orderShapeTransformPlans(plans: readonly BoundApplyPlan[]): BoundApplyPlan[] {
  const deletes = plans.filter((plan) => plan.target.kind === "delete")
    .sort((left, right) => depth(right.path) - depth(left.path) || comparePath(left.path, right.path));
  const puts = plans.filter((plan) => plan.target.kind === "put")
    .sort((left, right) => depth(left.path) - depth(right.path) || comparePath(left.path, right.path));
  return [...deletes, ...puts];
}

export function stableApplyPlanHash(plan: BoundApplyPlan): string {
  const normalized = JSON.stringify({
    ...plan,
    targetHeads: [...new Set(plan.targetHeads)].sort(),
  });
  return sha256Hex(new TextEncoder().encode(normalized));
}

function validatePlan(plan: BoundApplyPlan): void {
  if (plan.operationId.length === 0 || plan.path.length === 0 || plan.repositoryFingerprint.length === 0) throw new Error("ApplyPlan identity is invalid");
  if (!Number.isSafeInteger(plan.projectionGeneration) || plan.projectionGeneration < 0
    || !Number.isSafeInteger(plan.dirtyGeneration) || plan.dirtyGeneration < 0) throw new Error("ApplyPlan generation is invalid");
  if (plan.target.kind === "put" && (!/^[0-9a-f]{64}$/.test(plan.target.hash) || !Number.isSafeInteger(plan.target.size) || plan.target.size < 0)) {
    throw new Error("ApplyPlan target is invalid");
  }
}

function copyPlan(plan: BoundApplyPlan): BoundApplyPlan {
  return { ...plan, targetHeads: [...plan.targetHeads], target: { ...plan.target }, expectedLocal: { ...plan.expectedLocal } };
}

function guardMatches(plan: BoundApplyPlan, guard: ApplyGuardState): boolean {
  return guard.repositoryFingerprint === plan.repositoryFingerprint
    && sameSet(guard.observedHeads, plan.targetHeads)
    && guard.projectionGeneration === plan.projectionGeneration
    && guard.dirtyGeneration === plan.dirtyGeneration
    && !guard.hasDirtyIntent
    && !guard.hasLocalConcurrentRecord;
}

function observationMatchesExpected(observation: Exclude<LocalFileObservation, { kind: "unknown" }>, expected: BoundApplyPlan["expectedLocal"]): boolean {
  return expected.kind === "absent"
    ? observation.kind === "absent"
    : observation.kind === "present" && observation.hash === expected.hash && observation.size === expected.size;
}

function observationMatchesTarget(observation: Exclude<LocalFileObservation, { kind: "unknown" }>, target: ApplyTarget): boolean {
  return target.kind === "delete"
    ? observation.kind === "absent"
    : observation.kind === "present" && observation.hash === target.hash && observation.size === target.size;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === new Set(right).size && left.every((value) => right.includes(value));
}

function depth(path: string): number { return path.split("/").length; }
function comparePath(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
