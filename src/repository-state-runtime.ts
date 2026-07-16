import { DiagnosticError } from "../core/diagnostics";
import { DurableStateCorruptionError, DurableStateStore, type StateJsonValue } from "../core/durable-state";
import type { DurableOutboxEntry } from "../core/durable-outbox";
import {
  archiveRepositoryStateCopies,
  openRepositoryStateFiles,
  type LocalStatePathAdapter,
} from "../core/local-state-files";
import type { OperationalStatus } from "../core/operational-status";
import { repositoryDurablePayload } from "../core/repository-durable-payload";
import {
  validateRepositoryStatePayload,
  writeRepositoryStateTransaction,
} from "../core/repository-state-transaction";
import type { ConfigProfile } from "../core/types";
import { createDefaultConfigSyncState, type PersistedConfigSyncState } from "./config-center-types";
import type { S3SyncData } from "./types";
import { compareUtf8 } from "../protocol/utf8";

const RUNTIME_STATE_SCHEMA_VERSION = 1;

export type RepositoryStateRestoreResult =
  | { status: "initialized" }
  | { status: "restored"; configProfile?: ConfigProfile }
  | { status: "archived-and-reset"; archivedCopies: number; error: DiagnosticError };

export class RepositoryStateRuntime {
  private cached: { fingerprint: string; store: DurableStateStore<StateJsonValue> } | undefined;

  constructor(
    private readonly adapter: LocalStatePathAdapter,
    private readonly configDir: string,
    private readonly createArchiveId: () => string = () => `invalid-state-${Date.now()}-${crypto.randomUUID()}`,
  ) {}

  async store(state: NonNullable<S3SyncData["v1"]>): Promise<DurableStateStore<StateJsonValue>> {
    if (this.cached?.fingerprint !== state.repositoryFingerprint) {
      const files = await openRepositoryStateFiles(this.adapter, this.configDir, state.repositoryId);
      this.cached = {
        fingerprint: state.repositoryFingerprint,
        store: new DurableStateStore<StateJsonValue>(files),
      };
    }
    return this.cached.store;
  }

  clear(): void {
    this.cached = undefined;
  }

  projections(data: S3SyncData): StateJsonValue {
    return JSON.parse(JSON.stringify(durableVaultProjections(data))) as StateJsonValue;
  }

  async persist(data: S3SyncData): Promise<void> {
    const state = data.v1;
    if (!state) return;
    const payload = JSON.parse(JSON.stringify({
      runtimeStateSchemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
      ...repositoryDurablePayload(state) as Record<string, StateJsonValue>,
      dirtyIntents: data.v1DirtyIntents,
      projections: durableVaultProjections(data),
      outboxRefs: data.v1DurableOutbox.map(durableOutboxReference),
      durableOutbox: data.v1DurableOutbox,
      localConcurrentRecords: data.v1LocalConcurrentRecords,
      publishedReconciles: data.v1PublishedReconciles,
      recoveryRecords: data.v1RecoveryRecords,
      sparseSeenCommits: data.v1SparseSeenCommits,
      observedRegisters: data.v1ObservedRegisters,
      pendingApply: data.v1PendingApply,
      projectedHeads: data.v1ProjectedHeads,
      vaultEvents: data.v1VaultEvents,
      vaultGenerations: data.v1VaultGenerations,
      recoveryCandidates: data.v1RecoveryCandidates,
      applyJournals: data.v1ApplyJournals,
      files: data.files,
      conflicts: data.conflicts,
      operationalStatus: data.v1OperationalStatus,
      configSync: data.v1ConfigSync,
    })) as StateJsonValue;
    await writeRepositoryStateTransaction(await this.store(state), payload);
  }

  async restore(data: S3SyncData): Promise<RepositoryStateRestoreResult> {
    const state = data.v1;
    if (!state) return { status: "initialized" };
    const store = await this.store(state);
    let snapshot;
    try {
      snapshot = await store.load();
    } catch (cause) {
      if (!(cause instanceof DurableStateCorruptionError)) throw cause;
      return this.archiveAndReset(data, state, cause);
    }
    if (!snapshot) {
      await this.persist(data);
      return { status: "initialized" };
    }
    try {
      const decoded = decodeRuntimeState(snapshot.payload, state);
      applyDecodedRuntimeState(data, decoded);
      return {
        status: "restored",
        ...(decoded.configProfile ? { configProfile: decoded.configProfile } : {}),
      };
    } catch (cause) {
      if (!(cause instanceof DiagnosticError) || !cause.code.startsWith("DURABLE_STATE_")) throw cause;
      return this.archiveAndReset(data, state, cause);
    }
  }

  private async archiveAndReset(
    data: S3SyncData,
    state: NonNullable<S3SyncData["v1"]>,
    cause: unknown,
  ): Promise<Extract<RepositoryStateRestoreResult, { status: "archived-and-reset" }>> {
    const archive = await archiveRepositoryStateCopies(
      this.adapter,
      this.configDir,
      state.repositoryId,
      this.createArchiveId(),
    );
    this.clear();
    await this.persist(data);
    return {
      status: "archived-and-reset",
      archivedCopies: archive.archived.length,
      error: new DiagnosticError(
        "DURABLE_STATE_ARCHIVED_AND_RESET",
        "local-path",
        "invalid repository state copies were archived before a clean local state was initialized",
        cause,
      ),
    };
  }
}

interface DecodedRuntimeState {
  repository: NonNullable<S3SyncData["v1"]>;
  sparseSeenCommits: S3SyncData["v1SparseSeenCommits"];
  observedRegisters: S3SyncData["v1ObservedRegisters"];
  pendingApply: S3SyncData["v1PendingApply"];
  dirtyIntents: S3SyncData["v1DirtyIntents"];
  projectedHeads: S3SyncData["v1ProjectedHeads"];
  vaultEvents: S3SyncData["v1VaultEvents"];
  vaultGenerations: S3SyncData["v1VaultGenerations"];
  recoveryCandidates: S3SyncData["v1RecoveryCandidates"];
  applyJournals: S3SyncData["v1ApplyJournals"];
  localConcurrentRecords: S3SyncData["v1LocalConcurrentRecords"];
  publishedReconciles: S3SyncData["v1PublishedReconciles"];
  durableOutbox: S3SyncData["v1DurableOutbox"];
  recoveryRecords: S3SyncData["v1RecoveryRecords"];
  files: S3SyncData["files"];
  conflicts: S3SyncData["conflicts"];
  operationalStatus: OperationalStatus;
  configSync: PersistedConfigSyncState;
  configProfile?: ConfigProfile;
}

function decodeRuntimeState(
  payload: StateJsonValue,
  selected: NonNullable<S3SyncData["v1"]>,
): DecodedRuntimeState {
  const record = requireRecord(payload, "root");
  if (record.runtimeStateSchemaVersion !== RUNTIME_STATE_SCHEMA_VERSION) {
    throw new DiagnosticError("DURABLE_STATE_SCHEMA_UNSUPPORTED", "local-path", "repository runtime state schema is unsupported");
  }
  let durable: ReturnType<typeof validateRepositoryStatePayload>;
  try {
    durable = validateRepositoryStatePayload(payload);
  } catch (cause) {
    throw new DiagnosticError(
      "DURABLE_STATE_PAYLOAD_INVALID",
      "local-path",
      "repository runtime state payload is invalid",
      cause,
    );
  }
  if (durable.repositoryFingerprint !== selected.repositoryFingerprint) {
    throw new DiagnosticError("DURABLE_STATE_IDENTITY_MISMATCH", "repository-identity", "repository state identity does not match the selected repository");
  }
  const configSync = cloneRequiredRecord<PersistedConfigSyncState>(record.configSync, "configSync");
  const rawOperationalStatus = requireRecord(record.operationalStatus, "operationalStatus");
  requireRecord(rawOperationalStatus.audit, "operationalStatus.audit");
  const operationalStatus = structuredClone(rawOperationalStatus) as unknown as OperationalStatus;
  if (!Array.isArray(operationalStatus.recoveryBlockers)) {
    throw new DiagnosticError("DURABLE_STATE_STATUS_INVALID", "local-path", "repository operational status is invalid");
  }
  const normalizedConfigSync = { ...createDefaultConfigSyncState(), ...configSync };
  if (normalizedConfigSync.batchJournal?.state === "accounted") {
    normalizedConfigSync.batchJournal = undefined;
  } else if (normalizedConfigSync.batchJournal) {
    normalizedConfigSync.status = "recovery-required";
    normalizedConfigSync.lastError = "检测到未完成的配置批次，需要继续或回滚。";
  }
  return {
    // 访问路由来自 data.json；仓库状态只恢复因果身份和 writer 状态。
    repository: { ...durable, locator: { ...selected.locator } },
    sparseSeenCommits: cloneRequiredRecord(record.sparseSeenCommits, "sparseSeenCommits"),
    observedRegisters: cloneRequiredRecord(record.observedRegisters, "observedRegisters"),
    pendingApply: cloneRequiredRecord(record.pendingApply, "pendingApply"),
    dirtyIntents: cloneRequiredRecord(record.dirtyIntents, "dirtyIntents"),
    projectedHeads: cloneRequiredRecord(record.projectedHeads, "projectedHeads"),
    vaultEvents: cloneRequiredArray(record.vaultEvents, "vaultEvents"),
    vaultGenerations: cloneRequiredRecord(record.vaultGenerations, "vaultGenerations"),
    recoveryCandidates: cloneRequiredRecord(record.recoveryCandidates, "recoveryCandidates"),
    applyJournals: cloneRequiredArray(record.applyJournals, "applyJournals"),
    localConcurrentRecords: cloneRequiredRecord(record.localConcurrentRecords, "localConcurrentRecords"),
    publishedReconciles: cloneRequiredArray(record.publishedReconciles, "publishedReconciles"),
    durableOutbox: cloneRequiredArray(record.durableOutbox, "durableOutbox"),
    recoveryRecords: cloneRequiredRecord(record.recoveryRecords, "recoveryRecords"),
    files: cloneRequiredRecord(record.files, "files"),
    conflicts: cloneRequiredRecord(record.conflicts, "conflicts"),
    operationalStatus: {
      ...operationalStatus,
      recoveryBlockers: structuredClone(operationalStatus.recoveryBlockers),
      audit: structuredClone(operationalStatus.audit),
    },
    configSync: normalizedConfigSync,
    ...(!normalizedConfigSync.dirtyIntent && normalizedConfigSync.projectedTree
      ? { configProfile: configProfileFromTree(normalizedConfigSync.projectedTree) }
      : {}),
  };
}

function applyDecodedRuntimeState(data: S3SyncData, decoded: DecodedRuntimeState): void {
  data.v1 = decoded.repository;
  data.v1SparseSeenCommits = decoded.sparseSeenCommits;
  data.v1ObservedRegisters = decoded.observedRegisters;
  data.v1PendingApply = decoded.pendingApply;
  data.v1DirtyIntents = decoded.dirtyIntents;
  data.v1ProjectedHeads = decoded.projectedHeads;
  data.v1VaultEvents = decoded.vaultEvents;
  data.v1VaultGenerations = decoded.vaultGenerations;
  data.v1RecoveryCandidates = decoded.recoveryCandidates;
  data.v1ApplyJournals = decoded.applyJournals;
  data.v1LocalConcurrentRecords = decoded.localConcurrentRecords;
  data.v1PublishedReconciles = decoded.publishedReconciles;
  data.v1DurableOutbox = decoded.durableOutbox;
  data.v1RecoveryRecords = decoded.recoveryRecords;
  data.files = decoded.files;
  data.conflicts = decoded.conflicts;
  data.v1OperationalStatus = decoded.operationalStatus;
  data.v1ConfigSync = decoded.configSync;
}

function durableVaultProjections(data: S3SyncData): Record<string, {
  projectedHeads: string[];
  projectedValueHash: string | null;
  generation: number;
}> {
  const paths = new Set([
    ...Object.keys(data.v1ProjectedHeads),
    ...Object.keys(data.files),
    ...Object.keys(data.v1VaultGenerations),
  ]);
  return Object.fromEntries([...paths].sort(compareUtf8).map((path) => [path, {
    projectedHeads: [...(data.v1ProjectedHeads[path] ?? [])],
    projectedValueHash: data.files[path]?.hash ?? null,
    generation: data.v1VaultGenerations[path] ?? 0,
  }]));
}

function durableOutboxReference(entry: DurableOutboxEntry) {
  return {
    id: entry.id,
    writerId: entry.writerId,
    sequence: entry.sequence,
    commitHash: entry.commitHash,
    stagedPath: entry.objects.at(-1)?.contentRef ?? "missing",
    captureGeneration: entry.captureGeneration,
  };
}

function configProfileFromTree(tree: NonNullable<PersistedConfigSyncState["projectedTree"]>): ConfigProfile {
  const { schema: _schema, ...profile } = tree.profile;
  return structuredClone(profile);
}

function cloneRequiredRecord<T>(value: StateJsonValue | undefined, name: string): T {
  requireRecord(value, name);
  return structuredClone(value) as T;
}

function cloneRequiredArray<T>(value: StateJsonValue | undefined, name: string): T {
  if (!Array.isArray(value)) throw new DiagnosticError("DURABLE_STATE_SHAPE_INVALID", "local-path", `${name} is not an array`);
  return structuredClone(value) as T;
}

function requireRecord(value: StateJsonValue | undefined, name: string): Record<string, StateJsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DiagnosticError("DURABLE_STATE_SHAPE_INVALID", "local-path", `${name} is not an object`);
  }
  return value;
}

const utf8Encoder = new TextEncoder();
