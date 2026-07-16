import { describe, expect, it } from "vitest";
import { DurableStateStore, type DurableStateFileAdapter, type StateJsonValue } from "../../core/durable-state";
import { createRepositoryLocator, repositoryFingerprint } from "../../core/locator";
import { repositoryDurablePayload } from "../../core/repository-durable-payload";
import { writeRepositoryStateTransaction } from "../../core/repository-state-transaction";
import {
  beginDurableOutboxPublicationTransaction,
  clearPublishedLocalConcurrentRecordTransaction,
  completePublishedConfigOutboxTransaction,
  completePublishedVaultOutboxTransaction,
  confirmDurableOutboxPublishedTransaction,
  confirmTerminalDurableOutboxPublishedTransaction,
  failDurableOutboxPublicationTransaction,
  freezeDurableOutboxStateTransaction,
  markDurableWriterForkTransaction,
  persistLocalConcurrentRecordTransaction,
  persistRecoveryRecordTransaction,
  queueDeleteAfterFrozenRootPutTransaction,
  reconcilePublishedMutationStateTransaction,
  rotateDrainedDurableWriterTransaction,
} from "../../core/repository-state-transaction";
import type { DurableOutboxEntry, VerifiedTerminalOutboxProof } from "../../core/durable-outbox";
import { markLocalConcurrentSelectionPublished, selectLocalConcurrentRecordResolution } from "../../core/local-concurrent-resolution";
import { createRecoveryRecord, requestRecoveryCleanup } from "../../core/recovery-record";
import { createDefaultConfigProfile } from "../../core/config-profile";
import { buildConfigTreeObject, type ProtocolConfigTree } from "../../core/config-tree";
import { configBatchPlanHash, type ConfigBatchPlan } from "../../core/config-batch-apply";

class Files implements DurableStateFileAdapter {
  readonly values = new Map<string, string>();
  failNextWrite: "before" | "torn" | undefined;
  async read(name: "state-a.json" | "state-b.json") { return this.values.get(name); }
  async write(name: "state-a.json" | "state-b.json", source: string) {
    const failure = this.failNextWrite;
    this.failNextWrite = undefined;
    if (failure === "before") throw new Error("injected process termination before state write");
    this.values.set(name, failure === "torn" ? source.slice(0, -1) : source);
  }
  clone(): Files {
    const copy = new Files();
    for (const [name, source] of this.values) copy.values.set(name, source);
    return copy;
  }
}

describe("atomic repository state transaction", () => {
  const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
  const writerId = "123e4567-e89b-42d3-a456-426614174001";
  const descriptorHash = "a".repeat(64);
  const locator = createRepositoryLocator({ endpoint: "https://s3.example.com", region: "test", bucket: "vault", forcePathStyle: true, prefix: "team" });

  function payload(sequence: string, count: number): StateJsonValue {
    return { ...(repositoryDurablePayload({ repositoryId, descriptorHash, repositoryFingerprint: repositoryFingerprint(locator, repositoryId, descriptorHash), locator, configDir: ".obsidian", historicalConfigDirs: [], writerId, nextSequence: sequence, previousCommitHash: null, writerFrontiers: {} }) as Record<string, StateJsonValue>), dirtyIntents: { "a.md": { generation: count } }, projections: { "a.md": { projectedHeads: [], projectedValueHash: null, generation: count } }, outboxRefs: [], durableOutbox: [], publishedReconciles: [], localConcurrentRecords: {}, recoveryRecords: {}, sparseSeenCommits: {}, observedRegisters: {}, pendingApply: {} };
  }

  it("commits dirty intent, projection, writer sequence, and Outbox references in one generation", async () => {
    const store = new DurableStateStore<StateJsonValue>(new Files());
    const first = await writeRepositoryStateTransaction(store, payload("00000000000000000001", 1));
    const next = payload("00000000000000000002", 2) as Record<string, StateJsonValue>;
    next.outboxRefs = [{ id: "outbox-1", writerId, sequence: "00000000000000000001", commitHash: "b".repeat(64), stagedPath: "outbox/1", captureGeneration: 1 }];
    const second = await writeRepositoryStateTransaction(store, next);
    expect(first.generation).toBe(1);
    expect(second).toMatchObject({ generation: 2, payload: { dirtyIntents: { "a.md": { generation: 2 } }, projections: { "a.md": { generation: 2 } }, outboxRefs: [{ id: "outbox-1" }], nextSequence: "00000000000000000002" } });
  });

  it("rejects writer regression and conflicting reuse without advancing generation", async () => {
    const store = new DurableStateStore<StateJsonValue>(new Files());
    const current = payload("00000000000000000002", 1) as Record<string, StateJsonValue>;
    current.outboxRefs = [{ id: "one", writerId, sequence: "00000000000000000001", commitHash: "b".repeat(64), stagedPath: "outbox/1", captureGeneration: 1 }];
    await writeRepositoryStateTransaction(store, current);
    await expect(writeRepositoryStateTransaction(store, payload("00000000000000000001", 2))).rejects.toThrow("sequence regressed");
    const conflict = payload("00000000000000000002", 2) as Record<string, StateJsonValue>;
    conflict.outboxRefs = [current.outboxRefs[0], { id: "two", writerId, sequence: "00000000000000000001", commitHash: "c".repeat(64), stagedPath: "outbox/2", captureGeneration: 2 }];
    await expect(writeRepositoryStateTransaction(store, conflict)).rejects.toThrow("reuses a writer sequence");
    await expect(store.load()).resolves.toMatchObject({ generation: 1 });
  });

  it("rejects sparse Commit and observed register key mismatches", async () => {
    const store = new DurableStateStore<StateJsonValue>(new Files());
    const sparse = payload("00000000000000000001", 1) as Record<string, StateJsonValue>;
    sparse.sparseSeenCommits = { [("a".repeat(64))]: { key: "commit", writerId, sequence: "00000000000000000002", hash: "b".repeat(64), previousCommitHash: "c".repeat(64) } };
    await expect(writeRepositoryStateTransaction(store, sparse)).rejects.toThrow("sparse seen Commit");
    const observed = payload("00000000000000000001", 1) as Record<string, StateJsonValue>;
    observed.observedRegisters = { "vault:a.md": { key: "vault:b.md", heads: [], pending: [], invalid: [], disposition: "resolved", valueHash: null } };
    await expect(writeRepositoryStateTransaction(store, observed)).rejects.toThrow("observed register");
  });

  it("persists a bound config projection and rejects corrupt config causal state", async () => {
    const files = new Files();
    const store = new DurableStateStore<StateJsonValue>(files);
    const tree: ProtocolConfigTree = {
      protocol: 1,
      repositoryId,
      descriptorHash,
      profile: { schema: 1, ...createDefaultConfigProfile("1.8.0"), minimumTargetAppVersion: "1.8.0" },
      enabledCommunityPlugins: [],
      items: [],
    };
    const treeHash = buildConfigTreeObject("", tree, { configDir: ".obsidian", historicalConfigDirs: [] }, new Map()).hash;
    const head = `${"b".repeat(64)}:0:0`;
    const valid = payload("00000000000000000001", 1) as Record<string, StateJsonValue>;
    valid.configSync = {
      status: "ready",
      projectedHeads: [head],
      projectedTreeHash: treeHash,
      projectedTree: tree as unknown as StateJsonValue,
      generation: 1,
      reloadRequired: false,
    };
    await writeRepositoryStateTransaction(store, valid);
    await expect(new DurableStateStore<StateJsonValue>(files).load()).resolves.toMatchObject({
      payload: { configSync: { projectedHeads: [head], projectedTreeHash: treeHash } },
    });

    const corrupt = structuredClone(valid);
    corrupt.configSync = {
      ...(corrupt.configSync as Record<string, StateJsonValue>),
      dirtyIntent: { generation: 2, basisHeads: ["not-a-version"], projectedTreeHash: treeHash },
    };
    await expect(writeRepositoryStateTransaction(store, corrupt)).rejects.toThrow("config dirty intent");
    const removedState = structuredClone(valid);
    (removedState.configSync as Record<string, StateJsonValue>).status = "disabled";
    await expect(writeRepositoryStateTransaction(store, removedState)).rejects.toThrow("config sync state");
    await expect(store.load()).resolves.toMatchObject({ generation: 1 });
  });

  it("atomically retains a config batch Journal with its bound target Tree", async () => {
    const files = new Files();
    const store = new DurableStateStore<StateJsonValue>(files);
    const tree: ProtocolConfigTree = {
      protocol: 1,
      repositoryId,
      descriptorHash,
      profile: { schema: 1, ...createDefaultConfigProfile("1.8.0"), minimumTargetAppVersion: "1.8.0" },
      enabledCommunityPlugins: [],
      items: [],
    };
    const treeHash = buildConfigTreeObject("", tree, { configDir: ".obsidian", historicalConfigDirs: [] }, new Map()).hash;
    const plan: ConfigBatchPlan = {
      id: "batch-1",
      repositoryFingerprint: repositoryFingerprint(locator, repositoryId, descriptorHash),
      targetHeads: [`${"b".repeat(64)}:0:0`],
      projectedHeads: [],
      projectedTreeHash: null,
      targetTreeHash: treeHash,
      operations: [],
      diff: [],
      newPluginIds: [],
    };
    const state = payload("00000000000000000001", 1) as Record<string, StateJsonValue>;
    state.configSync = {
      status: "recovery-required",
      projectedHeads: [],
      projectedTreeHash: null,
      generation: 0,
      reloadRequired: false,
      batchJournal: {
        plan,
        planHash: configBatchPlanHash(plan),
        state: "applying",
        nextOperation: 0,
        snapshotRefs: {},
        displacedAfterRefs: [],
      } as unknown as StateJsonValue,
      batchTargetTree: tree as unknown as StateJsonValue,
    };
    await writeRepositoryStateTransaction(store, state);
    await expect(new DurableStateStore<StateJsonValue>(files).load()).resolves.toMatchObject({
      payload: { configSync: { batchJournal: { state: "applying" }, batchTargetTree: { repositoryId } } },
    });

    const incomplete = structuredClone(state);
    delete (incomplete.configSync as Record<string, StateJsonValue>).batchTargetTree;
    await expect(writeRepositoryStateTransaction(store, incomplete)).rejects.toThrow("recovery state is incomplete");
  });

  it("freezes the writer cursor and Outbox atomically, then confirms without clearing dirty state", async () => {
    const store = new DurableStateStore<StateJsonValue>(new Files());
    await writeRepositoryStateTransaction(store, payload("00000000000000000001", 1));
    const frozen = outbox("b".repeat(64), "00000000000000000001", null);
    const captured = await freezeDurableOutboxStateTransaction(store, frozen);
    expect(captured.payload).toMatchObject({
      nextSequence: "00000000000000000002",
      previousCommitHash: frozen.commitHash,
      dirtyIntents: { "a.md": { generation: 1 } },
      durableOutbox: [{ state: "queued", captureGeneration: 1 }],
      localPredecessors: { "vault:a.md": `${frozen.commitHash}:0:0` },
    });
    await beginDurableOutboxPublicationTransaction(store, frozen.id);
    const confirmed = await confirmDurableOutboxPublishedTransaction(store, frozen.id, frozen.commitHash, verifiedPatch(frozen));
    expect(confirmed.payload).toMatchObject({
      dirtyIntents: { "a.md": { generation: 1 } },
      durableOutbox: [{ state: "published" }],
      publishedReconciles: [{ outboxId: frozen.id, state: "pending", publishedVersionId: `${frozen.commitHash}:0:0` }],
      sparseSeenCommits: { [frozen.commitHash]: { hash: frozen.commitHash, sequence: frozen.sequence } },
      verifiedLocalPublications: { [`${frozen.commitHash}:0:0`]: { outboxId: frozen.id, registerKey: "vault:a.md" } },
    });
  });

  it("atomically confirms a terminal Outbox only after an exact remote proof", async () => {
    const store = new DurableStateStore<StateJsonValue>(new Files());
    await writeRepositoryStateTransaction(store, payload("00000000000000000001", 1));
    const frozen = outbox("9".repeat(64), "00000000000000000001", null);
    await freezeDurableOutboxStateTransaction(store, frozen);
    await beginDurableOutboxPublicationTransaction(store, frozen.id);
    await failDurableOutboxPublicationTransaction(store, frozen.id, "integrity-error");
    const proof = terminalProof(frozen);

    await expect(confirmTerminalDurableOutboxPublishedTransaction(store, {
      ...proof,
      commitHash: "8".repeat(64),
    }, verifiedPatch(frozen))).rejects.toThrow("does not match");
    await expect(store.load()).resolves.toMatchObject({ payload: { durableOutbox: [{ state: "integrity-error" }] } });

    const confirmed = await confirmTerminalDurableOutboxPublishedTransaction(store, proof, {
      ...verifiedPatch(frozen),
      operationalStatus: { recoveryRequired: false, repositoryIdentityValid: true },
    });
    expect(confirmed.payload).toMatchObject({
      durableOutbox: [{ state: "published" }],
      publishedReconciles: [{ outboxId: frozen.id, state: "pending" }],
      operationalStatus: { recoveryRequired: false, repositoryIdentityValid: true },
    });
  });

  it("rejects skipped or replaced reservations without changing the durable generation", async () => {
    const store = new DurableStateStore<StateJsonValue>(new Files());
    await writeRepositoryStateTransaction(store, payload("00000000000000000001", 1));
    await expect(freezeDurableOutboxStateTransaction(store, outbox("b".repeat(64), "00000000000000000002", null))).rejects.toThrow("writer cursor");
    await expect(store.load()).resolves.toMatchObject({ generation: 1, payload: { nextSequence: "00000000000000000001", durableOutbox: [] } });
  });

  it("persists LocalConcurrent selection state and clears it only after publication", async () => {
    const store = new DurableStateStore<StateJsonValue>(new Files());
    await writeRepositoryStateTransaction(store, payload("00000000000000000001", 1));
    const record = {
      path: "a.md",
      generation: 2,
      basisHeads: ["old"],
      editorValue: { kind: "put" as const, blob: { hash: "a".repeat(64), size: 1 }, stagedPath: "staged/editor" },
      externalValue: { kind: "put" as const, blob: { hash: "b".repeat(64), size: 1 }, stagedPath: "staged/external" },
    };
    const selected = selectLocalConcurrentRecordResolution({ record, choice: "editor" });
    await persistLocalConcurrentRecordTransaction(store, selected);
    await expect(clearPublishedLocalConcurrentRecordTransaction(store, record.path)).rejects.toThrow("not published");
    await persistLocalConcurrentRecordTransaction(store, markLocalConcurrentSelectionPublished(selected));
    await expect(clearPublishedLocalConcurrentRecordTransaction(store, record.path)).rejects.toThrow("unretained recovery content");
    await persistRecoveryRecordTransaction(store, createRecoveryRecord({
      id: "local-concurrent-external",
      contentRef: "staged/external",
      logicalPath: record.path,
      source: "local-concurrent",
      hash: "b".repeat(64),
      size: 1,
      capturedAt: 1,
    }));
    const cleared = await clearPublishedLocalConcurrentRecordTransaction(store, record.path);
    expect(cleared.payload).toMatchObject({ localConcurrentRecords: {} });
  });

  it("adopts only a matching published value and binds a different next generation to the frozen Version ID", async () => {
    const adoptedStore = new DurableStateStore<StateJsonValue>(new Files());
    await writeRepositoryStateTransaction(adoptedStore, payload("00000000000000000001", 1));
    const adoptedOutbox = outbox("b".repeat(64), "00000000000000000001", null);
    await freezeDurableOutboxStateTransaction(adoptedStore, adoptedOutbox);
    await beginDurableOutboxPublicationTransaction(adoptedStore, adoptedOutbox.id);
    await confirmDurableOutboxPublishedTransaction(adoptedStore, adoptedOutbox.id, adoptedOutbox.commitHash, verifiedPatch(adoptedOutbox));
    const adopted = await reconcilePublishedMutationStateTransaction(adoptedStore, {
      outboxId: adoptedOutbox.id,
      registerKey: "vault:a.md",
      projectionKey: "a.md",
      observation: { kind: "put", hash: "c".repeat(64), size: 1, stagedPath: `staged/${"c".repeat(64)}` },
    });
    expect(adopted.payload).toMatchObject({
      dirtyIntents: {},
      projections: { "a.md": { projectedHeads: [`${adoptedOutbox.commitHash}:0:0`], projectedValueHash: "c".repeat(64) } },
      publishedReconciles: [{ state: "adopted" }],
    });

    const changedStore = new DurableStateStore<StateJsonValue>(new Files());
    await writeRepositoryStateTransaction(changedStore, payload("00000000000000000001", 1));
    const changedOutbox = outbox("d".repeat(64), "00000000000000000001", null);
    await freezeDurableOutboxStateTransaction(changedStore, changedOutbox);
    await beginDurableOutboxPublicationTransaction(changedStore, changedOutbox.id);
    await confirmDurableOutboxPublishedTransaction(changedStore, changedOutbox.id, changedOutbox.commitHash, verifiedPatch(changedOutbox));
    await writeRepositoryStateTransaction(changedStore, {
      dirtyIntents: { "a.md": { path: "a.md", queueId: "a.md", generation: 2, basisHeads: ["new-remote-head"], awaitingLocalWrite: true } },
      observedRegisters: { "vault:a.md": { key: "vault:a.md", heads: ["new-remote-head"], pending: [], invalid: [], disposition: "resolved", valueHash: "f".repeat(64) } },
    });
    const changed = await reconcilePublishedMutationStateTransaction(changedStore, {
      outboxId: changedOutbox.id,
      registerKey: "vault:a.md",
      projectionKey: "a.md",
      observation: { kind: "put", hash: "e".repeat(64), size: 2, stagedPath: `staged/${"e".repeat(64)}` },
    });
    expect(changed.payload).toMatchObject({
      dirtyIntents: { "a.md": { generation: 2, basisHeads: [], localPredecessorVersion: `${changedOutbox.commitHash}:0:0` } },
      publishedReconciles: [{ state: "next-generation" }],
    });
  });

  it("keeps an unknown publication observation pending and persists explicit recovery cleanup transitions", async () => {
    const store = new DurableStateStore<StateJsonValue>(new Files());
    await writeRepositoryStateTransaction(store, payload("00000000000000000001", 1));
    const frozen = outbox("b".repeat(64), "00000000000000000001", null);
    await freezeDurableOutboxStateTransaction(store, frozen);
    await beginDurableOutboxPublicationTransaction(store, frozen.id);
    await confirmDurableOutboxPublishedTransaction(store, frozen.id, frozen.commitHash, verifiedPatch(frozen));
    const pending = await reconcilePublishedMutationStateTransaction(store, {
      outboxId: frozen.id,
      registerKey: "vault:a.md",
      projectionKey: "a.md",
      observation: { kind: "unknown" },
    });
    expect(pending.payload).toMatchObject({ publishedReconciles: [{ state: "pending" }], dirtyIntents: { "a.md": { generation: 1 } } });

    const recovery = createRecoveryRecord({ id: "r", contentRef: "recovery/r", logicalPath: "a.md", source: "apply-before-image", hash: "a".repeat(64), size: 1, capturedAt: 1 });
    await persistRecoveryRecordTransaction(store, recovery);
    await expect(persistRecoveryRecordTransaction(store, { ...recovery, cleanupState: "cleaned" })).rejects.toThrow("transition");
    const requested = requestRecoveryCleanup(recovery, { explicit: true, reviewedHash: recovery.lastStableHash, reviewedSize: recovery.lastStableSize });
    await persistRecoveryRecordTransaction(store, requested);
    await persistRecoveryRecordTransaction(store, { ...requested, cleanupState: "cleaned" });
  });

  it("persists a root-put deletion while waiting and freezes it only with the verified put Version ID", async () => {
    const files = new Files();
    let store = new DurableStateStore<StateJsonValue>(files);
    await writeRepositoryStateTransaction(store, payload("00000000000000000001", 1));
    const rootPut = outbox("b".repeat(64), "00000000000000000001", null);
    await freezeDurableOutboxStateTransaction(store, rootPut);
    await queueDeleteAfterFrozenRootPutTransaction(store, {
      registerKey: "vault:a.md",
      projectionKey: "a.md",
      rootOutboxId: rootPut.id,
      generation: 2,
      evidence: { source: "vault-event", generation: 2 },
    });
    store = new DurableStateStore<StateJsonValue>(files);
    const deletion = outbox("d".repeat(64), "00000000000000000002", rootPut.commitHash, {
      kind: "delete",
      parents: [`${rootPut.commitHash}:0:0`],
      valueHash: null,
      stagedContentRef: undefined,
    });
    await expect(freezeDurableOutboxStateTransaction(store, deletion)).rejects.toThrow("before its root put is verified");
    await beginDurableOutboxPublicationTransaction(store, rootPut.id);
    await confirmDurableOutboxPublishedTransaction(store, rootPut.id, rootPut.commitHash, verifiedPatch(rootPut));
    const frozenDelete = await freezeDurableOutboxStateTransaction(store, deletion);
    expect(frozenDelete.payload).toMatchObject({ waitingRootDeletes: {}, durableOutbox: [{ state: "published" }, { mutations: [{ kind: "delete", parents: [`${rootPut.commitHash}:0:0`] }] }] });
    await beginDurableOutboxPublicationTransaction(store, deletion.id);
    const publishedDelete = await confirmDurableOutboxPublishedTransaction(store, deletion.id, deletion.commitHash, verifiedPatch(deletion));
    expect(publishedDelete.payload).toMatchObject({
      verifiedLocalPublications: { [`${deletion.commitHash}:0:0`]: { registerKey: "vault:a.md", commitHash: deletion.commitHash } },
    });
  });

  it("stops a forked writer from freezing new work, drains verified bytes, then rotates without losing predecessors", async () => {
    const store = new DurableStateStore<StateJsonValue>(new Files());
    await writeRepositoryStateTransaction(store, payload("00000000000000000001", 1));
    const first = outbox("b".repeat(64), "00000000000000000001", null);
    const second = outbox("d".repeat(64), "00000000000000000002", first.commitHash);
    await freezeDurableOutboxStateTransaction(store, first);
    await freezeDurableOutboxStateTransaction(store, second);
    const forked = await markDurableWriterForkTransaction(store, writerId, new Set([first.id, second.id]));
    expect(forked.payload).toMatchObject({ writerForkState: { writerId, disposition: "drain" } });
    expect((forked.payload as Record<string, StateJsonValue>).durableOutbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ writerDisposition: "forked-draining" }),
    ]));
    await expect(freezeDurableOutboxStateTransaction(store, outbox("e".repeat(64), "00000000000000000003", second.commitHash))).rejects.toThrow("forked writer");
    for (const entry of [first, second]) {
      await beginDurableOutboxPublicationTransaction(store, entry.id);
      await confirmDurableOutboxPublishedTransaction(store, entry.id, entry.commitHash, verifiedPatch(entry));
    }
    const nextWriterId = "123e4567-e89b-42d3-a456-426614174002";
    const rotated = await rotateDrainedDurableWriterTransaction(store, nextWriterId);
    expect(rotated.payload).toMatchObject({
      writerId: nextWriterId,
      nextSequence: "00000000000000000001",
      previousCommitHash: null,
      localPredecessors: { "vault:a.md": `${second.commitHash}:0:0` },
    });
  });

  it("recovers or safely stops after process termination at every Task 5 state boundary", async () => {
    const files = new Files();
    await writeRepositoryStateTransaction(new DurableStateStore<StateJsonValue>(files), payload("00000000000000000001", 1));
    const rootPut = outbox("b".repeat(64), "00000000000000000001", null);
    const deletion = outbox("d".repeat(64), "00000000000000000002", rootPut.commitHash, {
      kind: "delete",
      parents: [`${rootPut.commitHash}:0:0`],
      valueHash: null,
      stagedContentRef: undefined,
    });

    await auditCrashBoundary(files, (store) => freezeDurableOutboxStateTransaction(store, rootPut));
    await auditCrashBoundary(files, (store) => queueDeleteAfterFrozenRootPutTransaction(store, {
      registerKey: "vault:a.md",
      projectionKey: "a.md",
      rootOutboxId: rootPut.id,
      generation: 2,
      evidence: { source: "vault-event", generation: 2 },
    }));
    await auditCrashBoundary(files, (store) => beginDurableOutboxPublicationTransaction(store, rootPut.id));
    await auditCrashBoundary(files, (store) => confirmDurableOutboxPublishedTransaction(store, rootPut.id, rootPut.commitHash, verifiedPatch(rootPut)));
    await auditCrashBoundary(files, (store) => freezeDurableOutboxStateTransaction(store, deletion));
    await auditCrashBoundary(files, (store) => beginDurableOutboxPublicationTransaction(store, deletion.id));
    await auditCrashBoundary(files, (store) => confirmDurableOutboxPublishedTransaction(store, deletion.id, deletion.commitHash, verifiedPatch(deletion)));
    await auditCrashBoundary(files, (store) => reconcilePublishedMutationStateTransaction(store, {
      outboxId: deletion.id,
      registerKey: "vault:a.md",
      projectionKey: "a.md",
      observation: { kind: "delete", evidence: { source: "stable-scan", generation: 2 } },
    }));

    const concurrent = {
      path: "b.md",
      generation: 2,
      basisHeads: ["old"],
      editorValue: { kind: "put" as const, blob: { hash: "a".repeat(64), size: 1 }, stagedPath: "staged/editor" },
      externalValue: { kind: "put" as const, blob: { hash: "e".repeat(64), size: 1 }, stagedPath: "staged/external" },
    };
    const selected = selectLocalConcurrentRecordResolution({ record: concurrent, choice: "editor" });
    await auditCrashBoundary(files, (store) => persistLocalConcurrentRecordTransaction(store, selected));
    const recovery = createRecoveryRecord({ id: "external", contentRef: "staged/external", logicalPath: "b.md", source: "local-concurrent", hash: "e".repeat(64), size: 1, capturedAt: 1 });
    await auditCrashBoundary(files, (store) => persistRecoveryRecordTransaction(store, recovery));
    await auditCrashBoundary(files, (store) => persistLocalConcurrentRecordTransaction(store, markLocalConcurrentSelectionPublished(selected)));
    await auditCrashBoundary(files, (store) => clearPublishedLocalConcurrentRecordTransaction(store, concurrent.path));
    await auditCrashBoundary(files, (store) => markDurableWriterForkTransaction(store, writerId, new Set([rootPut.id, deletion.id])));
    await auditCrashBoundary(files, (store) => rotateDrainedDurableWriterTransaction(store, "123e4567-e89b-42d3-a456-426614174002"));
  });

  it("freezes, retries, confirms, and accounts a Config publication without a cursor reuse window", async () => {
    const files = new Files();
    await writeRepositoryStateTransaction(new DurableStateStore<StateJsonValue>(files), payload("00000000000000000001", 1));
    const tree: ProtocolConfigTree = {
      protocol: 1,
      repositoryId,
      descriptorHash,
      profile: { schema: 1, ...createDefaultConfigProfile("1.8.0"), minimumTargetAppVersion: "1.8.0" },
      enabledCommunityPlugins: [],
      items: [],
    };
    const treeHash = buildConfigTreeObject("", tree, { configDir: ".obsidian", historicalConfigDirs: [] }, new Map()).hash;
    const frozen = outbox("e".repeat(64), "00000000000000000001", null, {
      registerKey: "config:portable",
      kind: "config-snapshot",
      valueHash: treeHash,
      stagedContentRef: undefined,
    });
    const configSync = {
      status: "local-changes",
      projectedHeads: [],
      projectedTreeHash: null,
      generation: 1,
      reloadRequired: false,
      publication: { outboxId: frozen.id, treeHash, tree, projectLocal: true },
    } as unknown as StateJsonValue;

    await auditCrashBoundary(files, (store) => freezeDurableOutboxStateTransaction(store, frozen, { configSync }));
    const queued = (await new DurableStateStore<StateJsonValue>(files).load())!;
    expect(queued.payload).toMatchObject({
      nextSequence: "00000000000000000002",
      previousCommitHash: frozen.commitHash,
      durableOutbox: [{ state: "queued" }],
      configSync: { publication: { outboxId: frozen.id, projectLocal: true } },
    });

    await auditCrashBoundary(files, (store) => beginDurableOutboxPublicationTransaction(store, frozen.id));
    await auditCrashBoundary(files, (store) => failDurableOutboxPublicationTransaction(store, frozen.id, "retryable-error"));
    await auditCrashBoundary(files, (store) => beginDurableOutboxPublicationTransaction(store, frozen.id));
    const staleQueued = queued.payload;
    await expect(writeRepositoryStateTransaction(new DurableStateStore<StateJsonValue>(files), staleQueued))
      .rejects.toThrow("Outbox state regressed");
    await auditCrashBoundary(files, (store) => confirmDurableOutboxPublishedTransaction(store, frozen.id, frozen.commitHash, verifiedPatch(frozen)));
    const confirmed = (await new DurableStateStore<StateJsonValue>(files).load())!;
    await auditCrashBoundary(files, (store) => completePublishedConfigOutboxTransaction(store, { outboxId: frozen.id, localTreeHash: treeHash }));
    await expect(new DurableStateStore<StateJsonValue>(files).load()).resolves.toMatchObject({
      payload: {
        nextSequence: "00000000000000000002",
        durableOutbox: [{ state: "published" }],
        publishedReconciles: [{ outboxId: frozen.id, state: "adopted" }],
        configSync: {
          status: "ready",
          projectedHeads: [`${frozen.commitHash}:0:0`],
          projectedTreeHash: treeHash,
          generation: 2,
        },
      },
    });
    await expect(writeRepositoryStateTransaction(new DurableStateStore<StateJsonValue>(files), confirmed.payload))
      .rejects.toThrow("restored a completed config publication");
  });

  it("advances the Config projection but keeps a new dirty generation when local bytes change after freezing", async () => {
    const store = new DurableStateStore<StateJsonValue>(new Files());
    await writeRepositoryStateTransaction(store, payload("00000000000000000001", 1));
    const tree: ProtocolConfigTree = {
      protocol: 1,
      repositoryId,
      descriptorHash,
      profile: { schema: 1, ...createDefaultConfigProfile("1.8.0"), minimumTargetAppVersion: "1.8.0" },
      enabledCommunityPlugins: [],
      items: [],
    };
    const treeHash = buildConfigTreeObject("", tree, { configDir: ".obsidian", historicalConfigDirs: [] }, new Map()).hash;
    const frozen = outbox("f".repeat(64), "00000000000000000001", null, {
      registerKey: "config:portable",
      kind: "config-snapshot",
      valueHash: treeHash,
      stagedContentRef: undefined,
    });
    await freezeDurableOutboxStateTransaction(store, frozen, {
      configSync: {
        status: "local-changes",
        projectedHeads: [],
        projectedTreeHash: null,
        generation: 1,
        reloadRequired: false,
        publication: { outboxId: frozen.id, treeHash, tree, projectLocal: true },
      } as unknown as StateJsonValue,
    });
    await beginDurableOutboxPublicationTransaction(store, frozen.id);
    await confirmDurableOutboxPublishedTransaction(store, frozen.id, frozen.commitHash, verifiedPatch(frozen));
    const changed = await completePublishedConfigOutboxTransaction(store, { outboxId: frozen.id, localTreeHash: "9".repeat(64) });
    expect(changed.payload).toMatchObject({
      publishedReconciles: [{ state: "next-generation" }],
      configSync: {
        status: "local-changes",
        projectedHeads: [`${frozen.commitHash}:0:0`],
        projectedTreeHash: treeHash,
        dirtyIntent: {
          generation: 2,
          basisHeads: [`${frozen.commitHash}:0:0`],
          projectedTreeHash: treeHash,
        },
      },
    });
  });

  it("atomically settles a published Vault Outbox with rebased later local intent", async () => {
    const store = new DurableStateStore<StateJsonValue>(new Files());
    await writeRepositoryStateTransaction(store, payload("00000000000000000001", 1));
    const frozen = outbox("7".repeat(64), "00000000000000000001", null, {
      capturedDirtyGeneration: 1,
      capturedEventGeneration: 2,
    });
    await freezeDurableOutboxStateTransaction(store, frozen);
    await beginDurableOutboxPublicationTransaction(store, frozen.id);
    const confirmed = await confirmDurableOutboxPublishedTransaction(store, frozen.id, frozen.commitHash, verifiedPatch(frozen));
    const nextDirty = {
      path: "a.md",
      generation: 3,
      editorGeneration: 3,
      expectedContentHash: "d".repeat(64),
      awaitingLocalWrite: true,
      basisHeads: ["remote-later"],
      projectedValueHash: "a".repeat(64),
      localCandidates: [],
      editorContents: [],
    };
    await writeRepositoryStateTransaction(store, {
      dirtyIntents: { "a.md": nextDirty },
      vaultEvents: [
        { id: "later", kind: "upsert", path: "a.md", generation: 3, basisHeads: ["remote-later"] },
        { id: "other", kind: "delete", path: "b.md", generation: 1, basisHeads: ["other-head"] },
      ],
      vaultGenerations: { "a.md": 3, "b.md": 1 },
    });
    const completed = await completePublishedVaultOutboxTransaction(store, {
      outboxId: frozen.id,
      registerKey: "vault:a.md",
      projectionKey: "a.md",
      localValueHash: "c".repeat(64),
      syntheticEventId: "synthetic",
      dirtyIntent: null,
      vaultEvents: [],
      vaultGeneration: 2,
    });
    expect(completed.payload).toMatchObject({
      dirtyIntents: { "a.md": { generation: 3, localPredecessorVersion: `${frozen.commitHash}:0:0` } },
      projections: { "a.md": { projectedHeads: [`${frozen.commitHash}:0:0`], projectedValueHash: "c".repeat(64) } },
      publishedReconciles: [{ state: "next-generation" }],
      vaultEvents: [
        { id: "later", basisHeads: [], localPredecessorVersion: `${frozen.commitHash}:0:0` },
        { id: "other", path: "b.md", basisHeads: ["other-head"] },
      ],
      vaultGenerations: { "a.md": 3, "b.md": 1 },
    });
    await expect(writeRepositoryStateTransaction(store, confirmed.payload))
      .rejects.toThrow("PublishedReconcile state regressed");
  });

  it("creates a post-publication event with the exact frozen predecessor when local bytes changed", async () => {
    const store = new DurableStateStore<StateJsonValue>(new Files());
    await writeRepositoryStateTransaction(store, payload("00000000000000000001", 1));
    const frozen = outbox("8".repeat(64), "00000000000000000001", null, {
      capturedDirtyGeneration: 1,
      capturedEventGeneration: 2,
    });
    await freezeDurableOutboxStateTransaction(store, frozen);
    await beginDurableOutboxPublicationTransaction(store, frozen.id);
    await confirmDurableOutboxPublishedTransaction(store, frozen.id, frozen.commitHash, verifiedPatch(frozen));
    const completed = await completePublishedVaultOutboxTransaction(store, {
      outboxId: frozen.id,
      registerKey: "vault:a.md",
      projectionKey: "a.md",
      localValueHash: "d".repeat(64),
      syntheticEventId: "post-publication",
      dirtyIntent: null,
      vaultEvents: [],
      vaultGeneration: 2,
    });
    expect(completed.payload).toMatchObject({
      publishedReconciles: [{ state: "next-generation" }],
      dirtyIntents: {},
      vaultEvents: [{
        id: "post-publication",
        generation: 3,
        basisHeads: [],
        localPredecessorVersion: `${frozen.commitHash}:0:0`,
      }],
      vaultGenerations: { "a.md": 3 },
    });
  });
});

function outbox(
  commitHash: string,
  sequence: string,
  previousCommitHash: string | null,
  mutation: Partial<DurableOutboxEntry["mutations"][number]> = {},
): DurableOutboxEntry {
  return {
    id: commitHash,
    repositoryFingerprint: repositoryFingerprint(
      createRepositoryLocator({ endpoint: "https://s3.example.com", region: "test", bucket: "vault", forcePathStyle: true, prefix: "team" }),
      "123e4567-e89b-42d3-a456-426614174000",
      "a".repeat(64),
    ),
    writerId: "123e4567-e89b-42d3-a456-426614174001",
    sequence,
    previousCommitHash,
    commitHash,
    captureGeneration: 1,
    state: "queued",
    writerDisposition: "active",
    objects: [{ kind: "commit", key: "commit", hash: commitHash, size: 1, contentRef: `staged/${commitHash}` }],
    mutations: [{
      registerKey: "vault:a.md",
      versionId: `${commitHash}:0:0`,
      kind: "put",
      parents: [],
      valueHash: "c".repeat(64),
      stagedContentRef: `staged/${"c".repeat(64)}`,
      ...mutation,
    }],
  };
}

function verifiedPatch(entry: DurableOutboxEntry): { observedRegisters: StateJsonValue; pendingApply: StateJsonValue } {
  const mutation = entry.mutations[0];
  return {
    observedRegisters: {
      [mutation.registerKey]: {
        key: mutation.registerKey,
        heads: [mutation.versionId],
        pending: [],
        invalid: [],
        disposition: "resolved",
        valueHash: mutation.valueHash,
      },
    },
    pendingApply: {},
  };
}

function terminalProof(entry: DurableOutboxEntry): VerifiedTerminalOutboxProof {
  return {
    outboxId: entry.id,
    repositoryFingerprint: entry.repositoryFingerprint,
    writerId: entry.writerId,
    sequence: entry.sequence,
    previousCommitHash: entry.previousCommitHash,
    commitHash: entry.commitHash,
    objects: entry.objects.map(({ kind, key, hash, size }) => ({ kind, key, hash, size })),
  };
}

async function auditCrashBoundary(
  files: Files,
  operation: (store: DurableStateStore<StateJsonValue>) => Promise<unknown>,
): Promise<void> {
  const before = await new DurableStateStore<StateJsonValue>(files).load();
  for (const failure of ["before", "torn"] as const) {
    const crashedFiles = files.clone();
    crashedFiles.failNextWrite = failure;
    await expect(operation(new DurableStateStore<StateJsonValue>(crashedFiles))).rejects.toThrow();
    await expect(new DurableStateStore<StateJsonValue>(crashedFiles).load()).resolves.toEqual(before);
  }
  await operation(new DurableStateStore<StateJsonValue>(files));
}
