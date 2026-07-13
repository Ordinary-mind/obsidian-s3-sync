import { describe, expect, it } from "vitest";
import { DurableStateStore, type DurableStateFileAdapter, type StateJsonValue } from "../../core/durable-state";
import { createRepositoryLocator, repositoryFingerprint } from "../../core/locator";
import { repositoryDurablePayload } from "../../core/repository-durable-payload";
import { writeRepositoryStateTransaction } from "../../core/repository-state-transaction";

class Files implements DurableStateFileAdapter {
  readonly values = new Map<string, string>();
  async read(name: "state-a.json" | "state-b.json") { return this.values.get(name); }
  async write(name: "state-a.json" | "state-b.json", source: string) { this.values.set(name, source); }
}

describe("atomic repository state transaction", () => {
  const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
  const writerId = "123e4567-e89b-42d3-a456-426614174001";
  const descriptorHash = "a".repeat(64);
  const locator = createRepositoryLocator({ endpoint: "https://s3.example.com", region: "test", bucket: "vault", forcePathStyle: true, prefix: "team" });

  function payload(sequence: string, count: number): StateJsonValue {
    return { ...(repositoryDurablePayload({ repositoryId, descriptorHash, repositoryFingerprint: repositoryFingerprint(locator, repositoryId, descriptorHash), locator, configDir: ".obsidian", historicalConfigDirs: [], writerId, nextSequence: sequence, previousCommitHash: null, writerFrontiers: {} }) as Record<string, StateJsonValue>), dirtyIntents: { "a.md": { generation: count } }, projections: { "a.md": { projectedHeads: [], projectedValueHash: null, generation: count } }, outboxRefs: [], sparseSeenCommits: {}, observedRegisters: {}, pendingApply: {} };
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
});
