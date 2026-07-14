import { describe, expect, it, vi } from "vitest";
import { buildBlobObject } from "../../core/blob";
import { buildConfigSnapshotPublishEnvelope } from "../../core/config-publish-envelope";
import { createDefaultConfigProfile } from "../../core/config-profile";
import type { ProtocolConfigTree } from "../../core/config-tree";
import { objectBodyFromBytes, type ObjectStore } from "../../core/object-store";
import { auditRemoteRepository } from "../../core/remote-audit";
import { publishEnvelope } from "../../core/remote-publish";
import { createRepositoryDescriptor } from "../../core/repository-bootstrap";
import {
  executeRepositoryGenerationMigration,
  writeRepositoryGeneration,
} from "../../core/repository-generation";
import { buildVaultPutPublishEnvelope } from "../../core/vault-publish-envelope";
import { sha256Hex } from "../../protocol/hash";

const sourceRepositoryId = "123e4567-e89b-42d3-a456-426614174000";
const targetRepositoryId = "123e4567-e89b-42d3-a456-426614174010";
const generationWriterId = "123e4567-e89b-42d3-a456-426614174020";
const createdAt = "2026-07-14T00:00:00.000Z";

describe("repository generation execution", () => {
  it("rewrites current and conflicting values, verifies both generations and retains the source", async () => {
    const store = new MemoryObjectStore();
    const source = await createRepositoryDescriptor(store, {
      prefix: "vault",
      repositoryId: sourceRepositoryId,
      configDir: ".obsidian",
      historicalConfigDirs: [],
    });
    await publishVaultHistoryAndConflict(store, source.descriptorHash);
    await publishConfigDeleteHistory(store, source.descriptorHash);
    const sourceKeysBefore = (await store.list(`vault/.obsidian-s3-sync/v1/repositories/${sourceRepositoryId}/`)).keys;
    const switched: string[] = [];

    const result = await executeRepositoryGenerationMigration({
      sourceRepositoryId,
      sourceDescriptorHash: source.descriptorHash,
      targetRepositoryId,
      sourceConfigDir: ".obsidian",
      sourceHistoricalConfigDirs: [],
      targetConfigDir: ".obsidian",
      participantHistoricalConfigDirs: [],
      auditSource: () => auditRemoteRepository(store, "vault", sourceRepositoryId, source.descriptorHash),
      createTargetDescriptor: (input) => createRepositoryDescriptor(store, { prefix: "vault", ...input }),
      writeTarget: async ({ sourceAudit, target }) => {
        await writeRepositoryGeneration({
          sourceStore: store,
          targetStore: store,
          sourcePrefix: "vault",
          targetPrefix: "vault",
          sourceAudit,
          target,
          writerId: generationWriterId,
          createdAt,
          clientVersion: "0.1.0",
        });
      },
      auditTarget: (target) => auditRemoteRepository(store, "vault", target.repositoryId, target.descriptorHash),
      switchDevices: async (target) => { switched.push(target.repositoryId); },
    });

    expect(result).toMatchObject({ status: "migrated", sourceRetained: true });
    if (result.status !== "migrated") throw new Error("expected completed generation migration");
    expect(result.target.logicalStateHash).toBe(result.source.logicalStateHash);
    expect(result.target.commitKeys.length).toBeLessThan(result.source.commitKeys.length);
    expect(result.plan.targetHistoricalConfigDirs).toEqual([]);
    expect(switched).toEqual([targetRepositoryId]);
    expect((await store.list(`vault/.obsidian-s3-sync/v1/repositories/${sourceRepositoryId}/`)).keys).toEqual(sourceKeysBefore);
    expect(result.target.values.filter((value) => value.channel === "vault" && value.logicalKey === "conflict.md")).toHaveLength(2);
    const configHead = result.target.values.find((value) => value.channel === "config");
    expect(configHead?.channel === "config" ? configHead.tree.items : []).toEqual([{ path: "app.json", kind: "delete" }]);
  });

  it("blocks every source Vault head newly covered by the target current config root", async () => {
    const store = new MemoryObjectStore();
    const source = await createRepositoryDescriptor(store, {
      prefix: "",
      repositoryId: sourceRepositoryId,
      configDir: ".obsidian",
      historicalConfigDirs: [],
    });
    const bytes = new TextEncoder().encode("must-export");
    const blob = buildBlobObject("", sourceRepositoryId, { bytes, hash: sha256Hex(bytes), size: bytes.byteLength });
    const envelope = buildVaultPutPublishEnvelope({
      prefix: "",
      repositoryId: sourceRepositoryId,
      descriptorHash: source.descriptorHash,
      writerId: "123e4567-e89b-42d3-a456-426614174001",
      sequence: "00000000000000000001",
      previousCommitHash: null,
      createdAt,
      clientVersion: "0.1.0",
      path: ".config/private.md",
      parents: [],
      capture: { bytes, hash: blob.hash, size: bytes.byteLength },
    });
    await publishEnvelope(store, envelope);
    const createTargetDescriptor = vi.fn();
    const switchDevices = vi.fn();

    const result = await executeRepositoryGenerationMigration({
      sourceRepositoryId,
      sourceDescriptorHash: source.descriptorHash,
      targetRepositoryId,
      sourceConfigDir: ".obsidian",
      sourceHistoricalConfigDirs: [],
      targetConfigDir: ".config",
      participantHistoricalConfigDirs: [],
      auditSource: () => auditRemoteRepository(store, "", sourceRepositoryId, source.descriptorHash),
      createTargetDescriptor,
      writeTarget: async () => undefined,
      auditTarget: async () => { throw new Error("target audit must not run"); },
      switchDevices,
    });

    expect(result).toMatchObject({
      status: "blocked",
      sourceRetained: true,
      blockingVersions: [{ path: ".config/private.md" }],
    });
    expect(createTargetDescriptor).not.toHaveBeenCalled();
    expect(switchDevices).not.toHaveBeenCalled();
  });

  it("aborts before target verification or device switching when the frozen source changes", async () => {
    const store = new MemoryObjectStore();
    const source = await createRepositoryDescriptor(store, {
      prefix: "",
      repositoryId: sourceRepositoryId,
      configDir: ".obsidian",
      historicalConfigDirs: [],
    });
    const audit = await auditRemoteRepository(store, "", sourceRepositoryId, source.descriptorHash);
    let audits = 0;
    const auditTarget = vi.fn();
    const switchDevices = vi.fn();

    await expect(executeRepositoryGenerationMigration({
      sourceRepositoryId,
      sourceDescriptorHash: source.descriptorHash,
      targetRepositoryId,
      sourceConfigDir: ".obsidian",
      sourceHistoricalConfigDirs: [],
      targetConfigDir: ".obsidian",
      participantHistoricalConfigDirs: [],
      auditSource: async () => {
        audits += 1;
        return audits === 1 ? audit : { ...audit, commitKeys: ["new-source-commit"] };
      },
      createTargetDescriptor: async () => ({ repositoryId: targetRepositoryId, descriptorHash: "a".repeat(64) }),
      writeTarget: async () => undefined,
      auditTarget,
      switchDevices,
    })).rejects.toThrow("changed after the migration snapshot was frozen");
    expect(auditTarget).not.toHaveBeenCalled();
    expect(switchDevices).not.toHaveBeenCalled();
  });
});

async function publishVaultHistoryAndConflict(store: ObjectStore, descriptorHash: string): Promise<void> {
  const oldBytes = new TextEncoder().encode("old");
  const newBytes = new TextEncoder().encode("new");
  const oldEnvelope = buildVaultPutPublishEnvelope({
    prefix: "vault", repositoryId: sourceRepositoryId, descriptorHash,
    writerId: "123e4567-e89b-42d3-a456-426614174001", sequence: "00000000000000000001",
    previousCommitHash: null, createdAt, clientVersion: "0.1.0", path: "history.md", parents: [],
    capture: { bytes: oldBytes, hash: sha256Hex(oldBytes), size: oldBytes.byteLength },
  });
  await publishEnvelope(store, oldEnvelope);
  const oldVersionId = `${oldEnvelope.commit.hash}:0:0`;
  const newEnvelope = buildVaultPutPublishEnvelope({
    prefix: "vault", repositoryId: sourceRepositoryId, descriptorHash,
    writerId: "123e4567-e89b-42d3-a456-426614174001", sequence: "00000000000000000002",
    previousCommitHash: oldEnvelope.commit.hash, createdAt, clientVersion: "0.1.0", path: "history.md", parents: [oldVersionId],
    capture: { bytes: newBytes, hash: sha256Hex(newBytes), size: newBytes.byteLength },
  });
  await publishEnvelope(store, newEnvelope);

  for (const [index, text] of ["left", "right"].entries()) {
    const bytes = new TextEncoder().encode(text);
    const envelope = buildVaultPutPublishEnvelope({
      prefix: "vault", repositoryId: sourceRepositoryId, descriptorHash,
      writerId: `123e4567-e89b-42d3-a456-42661417400${index + 2}`,
      sequence: "00000000000000000001", previousCommitHash: null, createdAt, clientVersion: "0.1.0",
      path: "conflict.md", parents: [], capture: { bytes, hash: sha256Hex(bytes), size: bytes.byteLength },
    });
    await publishEnvelope(store, envelope);
  }
}

async function publishConfigDeleteHistory(store: ObjectStore, descriptorHash: string): Promise<void> {
  const bytes = new TextEncoder().encode("settings");
  const blobHash = sha256Hex(bytes);
  const profile = { schema: 1 as const, ...createDefaultConfigProfile("1.8.0"), minimumTargetAppVersion: "1.8.0" };
  const rootTree: ProtocolConfigTree = {
    protocol: 1,
    repositoryId: sourceRepositoryId,
    descriptorHash,
    profile,
    enabledCommunityPlugins: [],
    items: [{ path: "app.json", kind: "put", blobHash, size: bytes.byteLength }],
  };
  const root = buildConfigSnapshotPublishEnvelope({
    prefix: "vault", repositoryId: sourceRepositoryId, descriptorHash,
    writerId: "123e4567-e89b-42d3-a456-426614174004", sequence: "00000000000000000001",
    previousCommitHash: null, createdAt, clientVersion: "0.1.0", parents: [], tree: rootTree,
    bytesByPath: new Map([["app.json", bytes]]), binding: { configDir: ".obsidian", historicalConfigDirs: [] },
  });
  await publishEnvelope(store, root.envelope);
  const deleteTree: ProtocolConfigTree = { ...rootTree, items: [{ path: "app.json", kind: "delete" }] };
  const deleted = buildConfigSnapshotPublishEnvelope({
    prefix: "vault", repositoryId: sourceRepositoryId, descriptorHash,
    writerId: "123e4567-e89b-42d3-a456-426614174004", sequence: "00000000000000000002",
    previousCommitHash: root.envelope.commit.hash, createdAt, clientVersion: "0.1.0", parents: [root.versionId],
    tree: deleteTree, bytesByPath: new Map(), binding: { configDir: ".obsidian", historicalConfigDirs: [] },
  });
  await publishEnvelope(store, deleted.envelope);
}

class MemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, Uint8Array>();

  async list(prefix: string): Promise<{ keys: string[]; objects: Array<{ key: string; size: number }> }> {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    return { keys, objects: keys.map((key) => ({ key, size: this.objects.get(key)!.byteLength })) };
  }

  async getStream(key: string): Promise<AsyncIterable<Uint8Array>> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error(`missing object: ${key}`);
    return objectBodyFromBytes(bytes);
  }

  async head(key: string): Promise<{ size: number }> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error(`missing object: ${key}`);
    return { size: bytes.byteLength };
  }

  async putImmutable(key: string, bytes: Uint8Array): Promise<void> {
    if (this.objects.has(key)) throw new Error(`object already exists: ${key}`);
    this.objects.set(key, new Uint8Array(bytes));
  }
}
