import { canonicalizeProtocolJson } from "../protocol/json";
import { sha256Hex } from "../protocol/hash";
import type { ConfigDiffEntry } from "./config-diff";
import type { LocalFileAdapter, LocalFileObservation } from "./local-file";

export type ConfigBatchTarget =
  | { kind: "put"; hash: string; size: number; stagedRef: string }
  | { kind: "delete" }
  | { kind: "stop-managing" };

export interface ConfigBatchOperation {
  path: string;
  expected: { kind: "present"; hash: string; size: number } | { kind: "absent" };
  target: ConfigBatchTarget;
  pluginId?: string;
  loadedPlugin?: boolean;
}

export interface ConfigBatchPlan {
  id: string;
  repositoryFingerprint: string;
  targetHeads: string[];
  projectedTreeHash: string | null;
  targetTreeHash: string;
  operations: ConfigBatchOperation[];
  diff: ConfigDiffEntry[];
}

export interface ConfigBatchConfirmation {
  planHash: string;
  acceptPluginCode: boolean;
  acceptSensitiveData: boolean;
  acceptLoadedPluginChanges: boolean;
}

export type ConfigBatchJournalState =
  | "prepared"
  | "snapshot-ready"
  | "applying"
  | "verifying"
  | "rolling-back"
  | "accounted"
  | "recovery-required";

export interface ConfigBatchJournal {
  plan: ConfigBatchPlan;
  planHash: string;
  state: ConfigBatchJournalState;
  nextOperation: number;
  snapshotRefs: Record<string, string | null>;
  displacedAfterRefs: string[];
}

export interface ConfigBatchGuard {
  repositoryFingerprint: string;
  observedHeads: string[];
  projectedTreeHash: string | null;
  currentTreeHash: string | null;
  hasDirtyIntent: boolean;
}

export interface ConfigBatchFileAdapter extends LocalFileAdapter {
  copyToRecoveryNoClobber(path: string, recoveryRef: string): Promise<boolean>;
}

export interface ConfigBatchStateStore {
  guard(): Promise<ConfigBatchGuard>;
  persistJournal(journal: ConfigBatchJournal): Promise<void>;
  accountProjection(targetHeads: readonly string[], targetTreeHash: string): Promise<void>;
  markConfigDirtyIntent(projectedHeads: readonly string[], projectedTreeHash: string | null): Promise<void>;
  markRecoveryRequired(journal: ConfigBatchJournal): Promise<void>;
}

export interface ConfigBatchOptions {
  snapshotRef(plan: ConfigBatchPlan, path: string): string;
  displacedBeforeRef(plan: ConfigBatchPlan, path: string): string;
  displacedAfterRef(plan: ConfigBatchPlan, path: string): string;
  verifyStaged(target: Extract<ConfigBatchTarget, { kind: "put" }>): Promise<void>;
  rebuildCurrentTreeHash(): Promise<string | null>;
}

export type ConfigBatchResult =
  | { status: "accounted" | "adopted-without-write"; journal: ConfigBatchJournal }
  | { status: "stale-plan" | "confirmation-required" | "local-change" | "rolled-back" | "recovery-required"; journal?: ConfigBatchJournal };

export function configBatchPlanHash(plan: ConfigBatchPlan): string {
  const normalized = {
    ...plan,
    targetHeads: [...new Set(plan.targetHeads)].sort(),
    operations: plan.operations.map((operation) => ({
      ...operation,
      target: operation.target.kind === "put"
        ? { kind: operation.target.kind, hash: operation.target.hash, size: operation.target.size }
        : operation.target,
    })),
  };
  return sha256Hex(new TextEncoder().encode(canonicalizeProtocolJson(normalized)));
}

export class SafeConfigBatchApplicator {
  constructor(
    private readonly files: ConfigBatchFileAdapter,
    private readonly state: ConfigBatchStateStore,
    private readonly options: ConfigBatchOptions,
  ) {}

  preview(plan: ConfigBatchPlan): { plan: ConfigBatchPlan; planHash: string; writesFormalConfig: false } {
    return { plan: copyPlan(plan), planHash: configBatchPlanHash(plan), writesFormalConfig: false };
  }

  async apply(plan: ConfigBatchPlan, confirmation: ConfigBatchConfirmation): Promise<ConfigBatchResult> {
    validatePlan(plan);
    const planHash = configBatchPlanHash(plan);
    if (!confirmationMatches(plan, planHash, confirmation)) return { status: "confirmation-required" };
    const guard = await this.state.guard();
    if (!remoteGuardMatches(plan, guard)) return { status: "stale-plan" };
    if (guard.currentTreeHash === plan.targetTreeHash && !guard.hasDirtyIntent) {
      const journal: ConfigBatchJournal = { plan: copyPlan(plan), planHash, state: "accounted", nextOperation: plan.operations.length, snapshotRefs: {}, displacedAfterRefs: [] };
      await this.state.accountProjection(plan.targetHeads, plan.targetTreeHash);
      await this.state.persistJournal(journal);
      return { status: "adopted-without-write", journal };
    }
    if (guard.hasDirtyIntent || guard.currentTreeHash !== plan.projectedTreeHash) {
      await this.state.markConfigDirtyIntent(plan.targetHeads, plan.projectedTreeHash);
      return { status: "local-change" };
    }
    for (const operation of plan.operations) {
      const observation = await this.files.observe(operation.path);
      if (observation.kind === "unknown" || !matchesExpected(observation, operation.expected)) {
        await this.state.markConfigDirtyIntent(plan.targetHeads, plan.projectedTreeHash);
        return { status: "local-change" };
      }
      if (operation.target.kind === "put") await this.options.verifyStaged(operation.target);
    }

    let journal: ConfigBatchJournal = {
      plan: { ...copyPlan(plan), operations: orderConfigOperations(plan.operations) },
      planHash,
      state: "prepared",
      nextOperation: 0,
      snapshotRefs: {},
      displacedAfterRefs: [],
    };
    await this.state.persistJournal(journal);
    try { journal = await this.captureCompleteSnapshot(journal); }
    catch { return this.rollback(journal); }
    return this.continueApply(journal);
  }

  async recover(journal: ConfigBatchJournal, action: "continue" | "rollback"): Promise<ConfigBatchResult> {
    if (journal.state === "accounted") return { status: "accounted", journal };
    if (journal.state === "recovery-required") return { status: "recovery-required", journal };
    if (action === "rollback") return this.rollback(journal);
    if (!remoteGuardMatches(journal.plan, await this.state.guard(), true)) return this.requireRecovery(journal);
    let snapshotReady = journal;
    try { snapshotReady = journal.state === "prepared" ? await this.captureCompleteSnapshot(journal) : journal; }
    catch { return this.rollback(journal); }
    return this.continueApply(snapshotReady);
  }

  private async captureCompleteSnapshot(journal: ConfigBatchJournal): Promise<ConfigBatchJournal> {
    const snapshotRefs = { ...journal.snapshotRefs };
    for (const operation of journal.plan.operations) {
      if (operation.expected.kind === "absent" || snapshotRefs[operation.path] !== undefined) {
        if (operation.expected.kind === "absent") snapshotRefs[operation.path] = null;
        continue;
      }
      const ref = this.options.snapshotRef(journal.plan, operation.path);
      const installed = await this.files.copyToRecoveryNoClobber(operation.path, ref);
      const snapshot = await this.files.observeRecovery(ref);
      if ((!installed && snapshot.kind !== "present") || snapshot.kind !== "present"
        || snapshot.hash !== operation.expected.hash || snapshot.size !== operation.expected.size) {
        throw new Error("config recovery snapshot mismatch");
      }
      snapshotRefs[operation.path] = ref;
    }
    const ready = { ...journal, state: "snapshot-ready" as const, snapshotRefs };
    await this.state.persistJournal(ready);
    return ready;
  }

  private async continueApply(journal: ConfigBatchJournal): Promise<ConfigBatchResult> {
    let current: ConfigBatchJournal = { ...journal, state: "applying" };
    await this.state.persistJournal(current);
    for (let index = current.nextOperation; index < current.plan.operations.length; index += 1) {
      if (!remoteGuardMatches(current.plan, await this.state.guard(), true)) return this.rollback(current);
      try { await this.applyOperation(current.plan, current.plan.operations[index]); }
      catch { return this.rollback(current); }
      current = { ...current, nextOperation: index + 1 };
      await this.state.persistJournal(current);
    }
    current = { ...current, state: "verifying" };
    await this.state.persistJournal(current);
    if (!remoteGuardMatches(current.plan, await this.state.guard(), true)) return this.requireRecovery(current);
    const actualTreeHash = await this.options.rebuildCurrentTreeHash();
    if (actualTreeHash !== current.plan.targetTreeHash) return this.rollback(current);
    await this.state.accountProjection(current.plan.targetHeads, current.plan.targetTreeHash);
    const accounted = { ...current, state: "accounted" as const };
    await this.state.persistJournal(accounted);
    return { status: "accounted", journal: accounted };
  }

  private async applyOperation(plan: ConfigBatchPlan, operation: ConfigBatchOperation): Promise<void> {
    if (operation.target.kind === "stop-managing") return;
    const active = await this.files.observe(operation.path);
    const beforeRef = this.options.displacedBeforeRef(plan, operation.path);
    const displaced = await this.files.observeRecovery(beforeRef);
    if (active.kind !== "unknown" && matchesTarget(active, operation.target)) return;
    if (operation.expected.kind === "present") {
      if (active.kind === "present" && matchesExpected(active, operation.expected)) {
        await this.files.moveToRecovery(operation.path, beforeRef);
      } else if (!(active.kind === "absent" && displaced.kind === "present"
        && displaced.hash === operation.expected.hash && displaced.size === operation.expected.size)) {
        throw new Error("config operation before-image changed");
      }
    } else if (active.kind !== "absent") {
      throw new Error("config operation expected absence changed");
    }
    if (operation.target.kind === "put") {
      if (!(await this.files.installStagedNoClobber(operation.target.stagedRef, operation.path))) throw new Error("config no-clobber install failed");
    }
    const after = await this.files.observe(operation.path);
    if (after.kind === "unknown" || !matchesTarget(after, operation.target)) throw new Error("config operation after-image mismatch");
  }

  private async rollback(journal: ConfigBatchJournal): Promise<ConfigBatchResult> {
    let rolling = { ...journal, state: "rolling-back" as const };
    await this.state.persistJournal(rolling);
    const operations = rolling.plan.operations.slice(0, Math.min(rolling.nextOperation + 1, rolling.plan.operations.length)).reverse();
    for (const operation of operations) {
      if (operation.target.kind === "stop-managing") continue;
      const active = await this.files.observe(operation.path);
      const beforeRef = this.options.displacedBeforeRef(rolling.plan, operation.path);
      const snapshotRef = rolling.snapshotRefs[operation.path];
      const before = await this.files.observeRecovery(beforeRef);
      const snapshot = typeof snapshotRef === "string" ? await this.files.observeRecovery(snapshotRef) : { kind: "absent" as const };
      const expectedRecovery = before.kind === "present" ? before : snapshot;

      if (active.kind !== "unknown" && matchesExpected(active, operation.expected)) continue;
      const partiallyMoved = active.kind === "absent" && operation.expected.kind === "present" && expectedRecovery.kind === "present";
      if (active.kind === "unknown" || (!matchesTarget(active, operation.target) && !partiallyMoved)) return this.requireRecovery(rolling);
      if (active.kind === "present") {
        const afterRef = this.options.displacedAfterRef(rolling.plan, operation.path);
        await this.files.moveToRecovery(operation.path, afterRef);
        rolling = { ...rolling, displacedAfterRefs: [...rolling.displacedAfterRefs, afterRef] };
        await this.state.persistJournal(rolling);
      }
      if (operation.expected.kind === "present") {
        if (expectedRecovery.kind !== "present" || expectedRecovery.hash !== operation.expected.hash || expectedRecovery.size !== operation.expected.size) {
          return this.requireRecovery(rolling);
        }
        const ref = before.kind === "present" ? beforeRef : snapshotRef as string;
        if (!(await this.files.restoreRecoveryNoClobber(ref, operation.path))) return this.requireRecovery(rolling);
      }
      const restored = await this.files.observe(operation.path);
      if (restored.kind === "unknown" || !matchesExpected(restored, operation.expected)) return this.requireRecovery(rolling);
    }
    await this.state.markConfigDirtyIntent(rolling.plan.targetHeads, rolling.plan.projectedTreeHash);
    return { status: "rolled-back", journal: rolling };
  }

  private async requireRecovery(journal: ConfigBatchJournal): Promise<ConfigBatchResult> {
    const failed = { ...journal, state: "recovery-required" as const };
    await this.state.persistJournal(failed);
    await this.state.markRecoveryRequired(failed);
    return { status: "recovery-required", journal: failed };
  }
}

export function orderConfigOperations(operations: readonly ConfigBatchOperation[]): ConfigBatchOperation[] {
  return [...operations].sort((left, right) => {
    const leftPriority = operationPriority(left); const rightPriority = operationPriority(right);
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    const leftDepth = left.path.split("/").length; const rightDepth = right.path.split("/").length;
    if (left.target.kind === "delete" && right.target.kind === "delete" && leftDepth !== rightDepth) return rightDepth - leftDepth;
    if (left.target.kind === "put" && right.target.kind === "put" && leftDepth !== rightDepth) return leftDepth - rightDepth;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
}

function operationPriority(operation: ConfigBatchOperation): number {
  if (operation.path === "community-plugins.json") return 3;
  if (/^plugins\/[^/]+\//.test(operation.path) && operation.path !== `plugins/${operation.pluginId ?? ""}/data.json`) return 0;
  return operation.target.kind === "stop-managing" ? 2 : 1;
}

function confirmationMatches(plan: ConfigBatchPlan, hash: string, confirmation: ConfigBatchConfirmation): boolean {
  if (confirmation.planHash !== hash) return false;
  if (plan.diff.some((entry) => entry.codeChange) && !confirmation.acceptPluginCode) return false;
  if (plan.diff.some((entry) => entry.sensitive) && !confirmation.acceptSensitiveData) return false;
  if (plan.operations.some((operation) => operation.loadedPlugin && operation.target.kind !== "stop-managing") && !confirmation.acceptLoadedPluginChanges) return false;
  return true;
}

function remoteGuardMatches(plan: ConfigBatchPlan, guard: ConfigBatchGuard, allowIntermediateTree = false): boolean {
  return guard.repositoryFingerprint === plan.repositoryFingerprint
    && sameSet(guard.observedHeads, plan.targetHeads)
    && guard.projectedTreeHash === plan.projectedTreeHash
    && !guard.hasDirtyIntent
    && (allowIntermediateTree || guard.currentTreeHash === plan.projectedTreeHash || guard.currentTreeHash === plan.targetTreeHash);
}

function matchesExpected(observation: Exclude<LocalFileObservation, { kind: "unknown" }>, expected: ConfigBatchOperation["expected"]): boolean {
  return expected.kind === "absent" ? observation.kind === "absent"
    : observation.kind === "present" && observation.hash === expected.hash && observation.size === expected.size;
}

function matchesTarget(observation: Exclude<LocalFileObservation, { kind: "unknown" }>, target: ConfigBatchTarget): boolean {
  if (target.kind === "stop-managing") return true;
  return target.kind === "delete" ? observation.kind === "absent"
    : observation.kind === "present" && observation.hash === target.hash && observation.size === target.size;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === new Set(right).size && left.every((value) => right.includes(value));
}

function validatePlan(plan: ConfigBatchPlan): void {
  if (plan.id.length === 0 || plan.repositoryFingerprint.length === 0 || !/^[0-9a-f]{64}$/.test(plan.targetTreeHash)) throw new Error("Config batch plan identity is invalid");
  if (new Set(plan.operations.map((operation) => operation.path)).size !== plan.operations.length) throw new Error("Config batch plan contains duplicate paths");
}

function copyPlan(plan: ConfigBatchPlan): ConfigBatchPlan { return structuredClone(plan); }
