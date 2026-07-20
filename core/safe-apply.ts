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
  projectedHeads: string[];
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
  writeMode?: "none" | "destructive";
  recoveryRef?: string;
  recoveryRecord?: RecoveryRecord;
  verifiedAfter?: { kind: "present"; hash: string; size: number } | { kind: "absent" };
}

export interface ApplyGuardState {
  repositoryFingerprint: string;
  observedHeads: string[];
  projectedHeads: string[];
  projectedValue: BoundApplyPlan["expectedLocal"];
  projectionGeneration: number;
  dirtyGeneration: number;
  hasDirtyIntent: boolean;
  hasDirtyRecord: boolean;
  hasLocalConcurrentRecord: boolean;
}

export interface SafeApplyStateStore {
  guard(path: string): Promise<ApplyGuardState>;
  persistJournal(journal: SafeApplyJournal): Promise<void>;
  persistRecovery(record: RecoveryRecord): Promise<void>;
  freezeLocalChange(path: string, observed: LocalFileObservation, basisHeads: readonly string[]): Promise<void>;
  accountProjection(
    plan: BoundApplyPlan,
    after: Exclude<LocalFileObservation, { kind: "unknown" }>,
    journal: SafeApplyJournal,
  ): Promise<void>;
}

export interface SafeApplyOptions {
  now(): number;
  recoveryRef(plan: BoundApplyPlan): string;
  recoveryContentRef(plan: BoundApplyPlan): string;
  conservativeCandidateRef(plan: BoundApplyPlan): string;
  verifyStaged(target: Extract<ApplyTarget, { kind: "put" }>): Promise<void>;
}

export type SafeApplyResult =
  | { status: "accounted"; journal: SafeApplyJournal }
  | { status: "adopted-without-write"; journal: SafeApplyJournal }
  | { status: "conservative-candidate"; candidateRef: string }
  | { status: "stale-plan" | "local-change-frozen" | "pending" | "recovery-required"; journal?: SafeApplyJournal };

export function rebindSafeApplyJournal(
  journal: SafeApplyJournal,
  input: Pick<BoundApplyPlan,
    "repositoryFingerprint" | "targetHeads" | "projectedHeads" | "target" | "projectionGeneration" | "dirtyGeneration">,
): SafeApplyJournal {
  const targetChanged = !sameApplyTarget(journal.target, input.target);
  if (targetChanged && !["prepared", "recovery-moved"].includes(journal.state)) {
    throw new Error("installed safe apply Journal cannot change target");
  }
  const rebound: SafeApplyJournal = {
    ...journal,
    repositoryFingerprint: input.repositoryFingerprint,
    targetHeads: [...input.targetHeads],
    projectedHeads: [...input.projectedHeads],
    target: { ...input.target },
    projectionGeneration: input.projectionGeneration,
    dirtyGeneration: input.dirtyGeneration,
  };
  if (targetChanged) delete rebound.verifiedAfter;
  validatePlan(rebound);
  return rebound;
}

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
    if (observationMatchesTarget(before, plan.target)) {
      return this.adoptWithoutWrite(plan, before);
    }
    if (!sameLocalValue(plan.expectedLocal, guard.projectedValue) || !observationMatchesExpected(before, plan.expectedLocal)) {
      await this.state.freezeLocalChange(plan.path, before, plan.projectedHeads);
      return { status: "local-change-frozen" };
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

    let journal: SafeApplyJournal = { ...copyPlan(plan), state: "prepared", writeMode: "destructive" };
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
        contentRef: this.options.recoveryContentRef(plan),
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
        if (active.kind !== "unknown") await this.state.freezeLocalChange(plan.path, active, plan.projectedHeads);
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
    if (!guardMatchesDestructive(plan, finalGuard) || finalAfter.kind === "unknown" || !observationMatchesTarget(finalAfter, plan.target)) {
      return this.failJournal(journal, "recovery-required");
    }
    journal = { ...journal, state: "accounted", verifiedAfter: finalAfter };
    await this.state.accountProjection(plan, finalAfter, journal);
    return { status: "accounted", journal };
  }

  async resume(journal: SafeApplyJournal): Promise<SafeApplyResult> {
    if (journal.state === "accounted") return { status: "accounted", journal };
    const plan = copyPlan(journal);
    const guard = await this.state.guard(plan.path);
    if (!guardMatches(plan, guard)) return this.failJournal(journal, "stale-plan");
    const active = await this.files.observe(plan.path);
    if (active.kind === "unknown") return { status: "pending", journal };

    if (observationMatchesTarget(active, plan.target)) {
      let resumable = journal;
      if (resumable.writeMode !== "none" && plan.expectedLocal.kind === "present" && !resumable.recoveryRecord) {
        const recoveryRef = resumable.recoveryRef ?? this.options.recoveryRef(plan);
        const recovered = await this.files.observeRecovery(recoveryRef);
        if (recovered.kind !== "present" || recovered.hash !== plan.expectedLocal.hash || recovered.size !== plan.expectedLocal.size) {
          return this.failJournal({ ...resumable, recoveryRef }, "recovery-required");
        }
        const recoveryRecord = createRecoveryRecord({
          id: plan.operationId,
          contentRef: this.options.recoveryContentRef(plan),
          logicalPath: plan.path,
          source: "apply-before-image",
          hash: recovered.hash,
          size: recovered.size,
          capturedAt: this.options.now(),
        });
        await this.state.persistRecovery(recoveryRecord);
        resumable = {
          ...resumable,
          recoveryRef,
          recoveryRecord,
          state: resumable.state === "prepared" ? "recovery-moved" : resumable.state,
        };
        await this.state.persistJournal(resumable);
      }
      return this.verifyAndAccountResumed(resumable, active);
    }
    if (journal.state === "recovery-required") return { status: "recovery-required", journal };
    if (!sameLocalValue(plan.expectedLocal, guard.projectedValue)) {
      await this.state.freezeLocalChange(plan.path, active, plan.projectedHeads);
      return this.failJournal(journal, "local-change-frozen");
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
        contentRef: this.options.recoveryContentRef(plan),
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
          if (concurrent.kind !== "unknown") await this.state.freezeLocalChange(plan.path, concurrent, plan.projectedHeads);
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
    await this.state.freezeLocalChange(plan.path, active, plan.projectedHeads);
    return this.failJournal(journal, "local-change-frozen");
  }

  private async adoptWithoutWrite(
    plan: BoundApplyPlan,
    observation: Exclude<LocalFileObservation, { kind: "unknown" }>,
  ): Promise<SafeApplyResult> {
    let journal: SafeApplyJournal = { ...copyPlan(plan), state: "verified", writeMode: "none", verifiedAfter: observation };
    await this.state.persistJournal(journal);
    const finalGuard = await this.state.guard(plan.path);
    const final = await this.files.observe(plan.path);
    if (!guardMatches(plan, finalGuard) || final.kind === "unknown" || !observationMatchesTarget(final, plan.target)) {
      return this.failJournal(journal, "stale-plan");
    }
    journal = { ...journal, state: "accounted", verifiedAfter: final };
    await this.state.accountProjection(plan, final, journal);
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
    const finalGuard = await this.state.guard(plan.path);
    const guardValid = verified.writeMode === "none" ? guardMatches(plan, finalGuard) : guardMatchesDestructive(plan, finalGuard);
    if (!guardValid || final.kind === "unknown" || !observationMatchesTarget(final, plan.target)) {
      return this.failJournal(verified, "recovery-required");
    }
    const accounted: SafeApplyJournal = { ...verified, state: "accounted", verifiedAfter: final };
    await this.state.accountProjection(plan, final, accounted);
    return { status: "accounted", journal: accounted };
  }

  private async guardBeforeIo(plan: BoundApplyPlan): Promise<boolean> {
    return guardMatchesDestructive(plan, await this.state.guard(plan.path));
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
  event: { operationId?: string; path: string; observation: LocalFileObservation },
): { ownEvent: boolean; expectation: ApplyEventExpectation } {
  if (expectation.consumed || event.operationId !== expectation.operationId
    || event.path !== expectation.path || event.observation.kind === "unknown") {
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

export type ShapeTransformJournalState = "prepared" | "applying" | "pending" | "accounted";

export interface ShapeTransformJournal {
  groupId: string;
  repositoryFingerprint: string;
  planHashes: string[];
  state: ShapeTransformJournalState;
  nextPlan: number;
}

export interface ShapeTransformStateStore {
  persistGroupJournal(journal: ShapeTransformJournal): Promise<void>;
  loadApplyJournal(operationId: string): Promise<SafeApplyJournal | undefined>;
}

export interface ApplyPlanExecutor {
  apply(plan: BoundApplyPlan): Promise<SafeApplyResult>;
  resume(journal: SafeApplyJournal): Promise<SafeApplyResult>;
}

export type ShapeTransformResult =
  | { status: "accounted"; journal: ShapeTransformJournal }
  | { status: "pending"; journal: ShapeTransformJournal; path: string };

export class SafeShapeTransformApplicator {
  constructor(
    private readonly files: LocalFileAdapter,
    private readonly applicator: ApplyPlanExecutor,
    private readonly state: ShapeTransformStateStore,
  ) {}

  async apply(plans: readonly BoundApplyPlan[], persisted?: ShapeTransformJournal): Promise<ShapeTransformResult> {
    const ordered = orderShapeTransformPlans(plans);
    const groupId = requiredGroupId(ordered);
    const planHashes = ordered.map(stableApplyPlanHash);
    let journal = persisted ?? {
      groupId,
      repositoryFingerprint: ordered[0].repositoryFingerprint,
      planHashes,
      state: "prepared" as const,
      nextPlan: 0,
    };
    validateShapeJournal(journal, groupId, ordered[0].repositoryFingerprint, planHashes);
    if (journal.state === "accounted") return { status: "accounted", journal };
    if (!persisted) await this.state.persistGroupJournal(journal);
    if (journal.nextPlan < ordered.length && localApplyMode(this.files.capabilities) === "conservative") {
      return this.pending(journal, ordered[journal.nextPlan].path);
    }

    for (let index = journal.nextPlan; index < ordered.length; index += 1) {
      const plan = ordered[index];
      journal = { ...journal, state: "applying", nextPlan: index };
      await this.state.persistGroupJournal(journal);
      if (plan.target.kind === "put" && plan.expectedLocal.kind === "absent") {
        const prepared = await this.prepareDirectoryTarget(plan.path);
        if (!prepared) return this.pending(journal, plan.path);
      }
      const memberJournal = await this.state.loadApplyJournal(plan.operationId);
      const result = memberJournal ? await this.applicator.resume(memberJournal) : await this.applicator.apply(plan);
      if (result.status !== "accounted" && result.status !== "adopted-without-write") {
        return this.pending(journal, plan.path);
      }
      journal = { ...journal, nextPlan: index + 1 };
      await this.state.persistGroupJournal(journal);
    }
    journal = { ...journal, state: "accounted" };
    await this.state.persistGroupJournal(journal);
    return { status: "accounted", journal };
  }

  private async prepareDirectoryTarget(path: string): Promise<boolean> {
    const observation = await this.files.observe(path);
    if (observation.kind !== "unknown") return true;
    const removed = await this.files.removeEmptyDirectoryNoFollow(path);
    if (removed !== "removed" && removed !== "absent") return false;
    return (await this.files.observe(path)).kind === "absent";
  }

  private async pending(journal: ShapeTransformJournal, path: string): Promise<ShapeTransformResult> {
    const pending = { ...journal, state: "pending" as const };
    await this.state.persistGroupJournal(pending);
    return { status: "pending", journal: pending, path };
  }
}

export function stableApplyPlanHash(plan: BoundApplyPlan): string {
  const normalized = JSON.stringify({
    ...plan,
    targetHeads: [...new Set(plan.targetHeads)].sort(),
    projectedHeads: [...new Set(plan.projectedHeads)].sort(),
  });
  return sha256Hex(new TextEncoder().encode(normalized));
}

function validatePlan(plan: BoundApplyPlan): void {
  if (plan.operationId.length === 0 || plan.path.length === 0 || plan.repositoryFingerprint.length === 0) throw new Error("ApplyPlan identity is invalid");
  if (!Number.isSafeInteger(plan.projectionGeneration) || plan.projectionGeneration < 0
    || !Number.isSafeInteger(plan.dirtyGeneration) || plan.dirtyGeneration < 0) throw new Error("ApplyPlan generation is invalid");
  if (new Set(plan.targetHeads).size !== plan.targetHeads.length || new Set(plan.projectedHeads).size !== plan.projectedHeads.length) {
    throw new Error("ApplyPlan heads are duplicated");
  }
  if (plan.target.kind === "put" && (!/^[0-9a-f]{64}$/.test(plan.target.hash) || !Number.isSafeInteger(plan.target.size) || plan.target.size < 0)) {
    throw new Error("ApplyPlan target is invalid");
  }
}

function copyPlan(plan: BoundApplyPlan): BoundApplyPlan {
  return { ...plan, targetHeads: [...plan.targetHeads], projectedHeads: [...plan.projectedHeads], target: { ...plan.target }, expectedLocal: { ...plan.expectedLocal } };
}

function guardMatches(plan: BoundApplyPlan, guard: ApplyGuardState): boolean {
  return guard.repositoryFingerprint === plan.repositoryFingerprint
    && sameSet(guard.observedHeads, plan.targetHeads)
    && sameSet(guard.projectedHeads, plan.projectedHeads)
    && guard.projectionGeneration === plan.projectionGeneration
    && guard.dirtyGeneration === plan.dirtyGeneration
    && !guard.hasDirtyIntent
    && !guard.hasDirtyRecord
    && !guard.hasLocalConcurrentRecord;
}

function guardMatchesDestructive(plan: BoundApplyPlan, guard: ApplyGuardState): boolean {
  return guardMatches(plan, guard) && sameLocalValue(plan.expectedLocal, guard.projectedValue);
}

function sameLocalValue(left: BoundApplyPlan["expectedLocal"], right: BoundApplyPlan["expectedLocal"]): boolean {
  return left.kind === "absent" ? right.kind === "absent"
    : right.kind === "present" && left.hash === right.hash && left.size === right.size;
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

function sameApplyTarget(left: ApplyTarget, right: ApplyTarget): boolean {
  return left.kind === "delete" ? right.kind === "delete"
    : right.kind === "put" && left.hash === right.hash && left.size === right.size;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === new Set(right).size && left.every((value) => right.includes(value));
}

function depth(path: string): number { return path.split("/").length; }
function comparePath(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

function requiredGroupId(plans: readonly BoundApplyPlan[]): string {
  if (plans.length < 2) throw new Error("shape transform group needs at least two plans");
  const groupId = plans[0].groupId;
  if (!groupId || plans.some((plan) => plan.groupId !== groupId)) throw new Error("shape transform plans must share one groupId");
  if (plans.some((plan) => plan.repositoryFingerprint !== plans[0].repositoryFingerprint)) {
    throw new Error("shape transform plans cross repository bindings");
  }
  return groupId;
}

function validateShapeJournal(
  journal: ShapeTransformJournal,
  groupId: string,
  repositoryFingerprint: string,
  planHashes: readonly string[],
): void {
  if (journal.groupId !== groupId || journal.repositoryFingerprint !== repositoryFingerprint
    || !["prepared", "applying", "pending", "accounted"].includes(journal.state)
    || journal.planHashes.length !== planHashes.length
    || journal.planHashes.some((hash, index) => hash !== planHashes[index])
    || !Number.isSafeInteger(journal.nextPlan) || journal.nextPlan < 0 || journal.nextPlan > planHashes.length) {
    throw new Error("shape transform Journal does not match its plans");
  }
}
