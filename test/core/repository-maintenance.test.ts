import { describe, expect, it } from "vitest";
import {
  calculateRepositorySpaceStatistics,
  listRepositoryProtocolObjects,
  orphanMaintenanceDisposition,
} from "../../core/repository-statistics";
import {
  authorizeMaintenanceDeletion,
  buildRepositoryGenerationPlan,
  inPlaceGarbageCollectionDisposition,
  maintenanceDeletionChallenge,
  mayMigrateGeneration,
  recordGenerationAudit,
  validateProtocolLifecycleRule,
} from "../../core/maintenance-plan";
import type { RemoteAuditResult } from "../../core/remote-audit";
import { InMemoryRepositoryCore } from "../../core/repository";

describe("repository space statistics", () => {
  it("separates active, conflict, history and pre-Commit orphans while reporting dedup and cost", () => {
    const objects = [
      { key: "active", kind: "blob" as const, size: 10 },
      { key: "conflict", kind: "blob" as const, size: 20 },
      { key: "history", kind: "commit" as const, size: 30 },
      { key: "orphan", kind: "change-chunk" as const, size: 40 },
    ];
    const stats = calculateRepositorySpaceStatistics({
      objects,
      activeKeys: new Set(["active"]), conflictKeys: new Set(["conflict"]), historicalKeys: new Set(["history"]),
      logicalReferencedBytes: 150,
      requestCounts: { list: 10, get: 20, put: 5 },
      pricePerThousandRequests: { list: 0.01, get: 0.001, put: 0.02 },
    });
    expect(stats.categories).toMatchObject({ active: { bytes: 10 }, conflict: { bytes: 20 }, history: { bytes: 30 }, orphan: { bytes: 40 } });
    expect(stats).toMatchObject({
      uniqueBytes: 100,
      reachableBytes: 60,
      uniqueReferencedBlobBytes: 30,
      dedupSavedBytes: 120,
      historyGrowthBytes: 30,
      orphanKeys: ["orphan"],
    });
    expect(stats.estimatedRequestCost).toBeCloseTo(0.00022);
    expect(orphanMaintenanceDisposition()).toBe("report-only-no-automatic-delete");
  });

  it("lists every protocol object kind across pages and falls back to HEAD for missing sizes", async () => {
    const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
    const root = `vault/.obsidian-s3-sync/v1/repositories/${repositoryId}/`;
    const hash = "a".repeat(64);
    const keys = [
      `${root}blobs/sha256/aa/${hash}`,
      `${root}config-trees/sha256/aa/${hash}.json`,
      `${root}changes/sha256/aa/${hash}.json`,
      `${root}commits/123e4567-e89b-42d3-a456-426614174001/00000000000000000001-${hash}.json`,
    ];
    const impostors = [
      `${root}blobs/sha256/ff/${hash}`,
      `${root}config-trees/sha256/aa/${hash}`,
      `${root}changes/sha256/aa/${hash}.bin`,
    ];
    const heads: string[] = [];
    const store = {
      list: async (_prefix: string, token?: string) => token === undefined
        ? { keys: [keys[1], keys[0], `${root}format.json`], objects: [{ key: keys[0], size: 10 }], continuationToken: "page-2" }
        : { keys: [keys[3], keys[2], ...impostors], objects: [{ key: keys[2], size: 30 }, { key: keys[3], size: 40 }] },
      head: async (key: string) => { heads.push(key); return { size: 20 }; },
    };

    await expect(listRepositoryProtocolObjects(store, "vault", repositoryId)).resolves.toEqual([
      { key: keys[0], kind: "blob", size: 10, contentHash: hash },
      { key: keys[2], kind: "change-chunk", size: 30, contentHash: hash },
      { key: keys[3], kind: "commit", size: 40, contentHash: hash },
      { key: keys[1], kind: "config-tree", size: 20, contentHash: hash },
    ].sort((left, right) => left.key.localeCompare(right.key)));
    expect(heads).toEqual([keys[1]]);
  });

  it("rejects repeated pagination tokens instead of looping forever", async () => {
    const store = {
      list: async () => ({ keys: [], continuationToken: "again" }),
      head: async () => ({ size: 0 }),
    };
    await expect(listRepositoryProtocolObjects(store, "", "repo")).rejects.toThrow("repeated continuation token");
  });
});

describe("new repository generation maintenance", () => {
  it("inherits histories, blocks overlapping newly excluded Vault versions, audits both sides and retains source", () => {
    let plan = buildRepositoryGenerationPlan({
      sourceRepositoryId: "old", targetRepositoryId: "new", sourceConfigDir: ".obsidian", sourceHistoricalConfigDirs: [".old"],
      targetConfigDir: ".config", participantHistoricalConfigDirs: ["private"],
      sourceVaultHeads: [{ path: "private/note.md", versionId: "v" }, { path: "notes/a.md", versionId: "safe" }],
    });
    expect(plan.targetHistoricalConfigDirs).toEqual([".obsidian", ".old", "private"]);
    expect(plan.blockingVersions).toEqual([{ path: "private/note.md", versionId: "v" }]);
    expect(plan.phases.at(-1)).toBe("retain-source");
    expect(mayMigrateGeneration(plan)).toBe(false);
    plan = { ...plan, blockingVersions: [] };
    plan = recordGenerationAudit(recordGenerationAudit(plan, "source", true), "target", true);
    expect(mayMigrateGeneration(plan)).toBe(true);
  });

  it("prohibits in-place garbage collection", () => {
    expect(inPlaceGarbageCollectionDisposition()).toBe("prohibited-without-multi-device-fault-proof");
  });

  it("binds maintenance deletion to real complete audits, a scoped credential and two independent challenges", () => {
    const source = completeAudit("123e4567-e89b-42d3-a456-426614174000", "a".repeat(64));
    const target = completeAudit("123e4567-e89b-42d3-a456-426614174010", "b".repeat(64));
    const challenge = maintenanceDeletionChallenge(source.repositoryId, target.repositoryId);
    const migration = completedMigration(source, target);
    const request = {
      prefix: "vault",
      sourceAudit: source,
      targetAudit: target,
      migration,
      normalSyncCredentialId: "device",
      capability: {
        kind: "repository-maintenance-delete" as const,
        credentialId: "maintenance",
        repositoryId: source.repositoryId,
        scopePrefix: `vault/.obsidian-s3-sync/v1/repositories/${source.repositoryId}`,
        deleteObject: true as const,
      },
      firstConfirmation: { confirmationId: "first", challenge, confirmedAt: 1 },
      secondConfirmation: { confirmationId: "second", challenge, confirmedAt: 2 },
    };
    expect(authorizeMaintenanceDeletion(request)).toMatchObject({
      sourceRepositoryId: source.repositoryId,
      targetRepositoryId: target.repositoryId,
      credentialId: "maintenance",
      confirmationIds: ["first", "second"],
    });
    expect(() => authorizeMaintenanceDeletion({
      ...request,
      sourceAudit: { ...source, missingClosure: ["missing"] },
    })).toThrow("complete source");
    expect(() => authorizeMaintenanceDeletion({
      ...request,
      capability: { ...request.capability, credentialId: "device" },
    })).toThrow("independent");
    expect(() => authorizeMaintenanceDeletion({
      ...request,
      secondConfirmation: { ...request.secondConfirmation, confirmationId: "first" },
    })).toThrow("two ordered independent");
    expect(() => authorizeMaintenanceDeletion({
      ...request,
      migration: {
        ...migration,
        target: { ...migration.target, logicalStateHash: "c".repeat(64) },
      },
    })).toThrow("equivalent");
    expect(() => authorizeMaintenanceDeletion({
      ...request,
      sourceAudit: { ...source, commitKeys: ["late-source-commit"] },
    })).toThrow("equivalent");
  });

  it("rejects LastModified expiration rules covering the protocol root", () => {
    expect(() => validateProtocolLifecycleRule({ rulePrefix: "vault", protocolRoot: "vault/.obsidian-s3-sync/v1", expiresByLastModified: true })).toThrow("LastModified");
    expect(() => validateProtocolLifecycleRule({ rulePrefix: "vault/.obsidian-s3-sync/v1/repositories/repo/blobs", protocolRoot: "vault/.obsidian-s3-sync/v1", expiresByLastModified: true })).toThrow("LastModified");
    expect(() => validateProtocolLifecycleRule({ rulePrefix: "vault/tmp", protocolRoot: "vault/.obsidian-s3-sync/v1", expiresByLastModified: true })).not.toThrow();
  });
});

function completeAudit(repositoryId: string, descriptorHash: string): RemoteAuditResult {
  return {
    repositoryId,
    descriptorHash,
    configDir: ".obsidian",
    historicalConfigDirs: [],
    repository: new InMemoryRepositoryCore(),
    commitKeys: [],
    verifiedObjects: 1,
    totalObjects: 1,
    missingClosure: [],
    status: "complete",
    deletionEvidenceAllowed: true,
    reachableObjects: [],
    versionObjectKeys: new Map(),
    logicalReferencedBlobBytes: 0,
  };
}

function completedMigration(source: RemoteAuditResult, target: RemoteAuditResult) {
  const logicalStateHash = "d".repeat(64);
  const frozen = (audit: RemoteAuditResult) => ({
    repositoryId: audit.repositoryId,
    descriptorHash: audit.descriptorHash,
    commitKeys: [],
    commitSetHash: "e".repeat(64),
    logicalStateHash,
    values: [],
    vaultHeads: [],
  });
  return {
    status: "migrated" as const,
    plan: buildRepositoryGenerationPlan({
      sourceRepositoryId: source.repositoryId,
      targetRepositoryId: target.repositoryId,
      sourceConfigDir: ".obsidian",
      sourceHistoricalConfigDirs: [],
      targetConfigDir: ".obsidian",
      participantHistoricalConfigDirs: [],
      sourceVaultHeads: [],
    }),
    source: frozen(source),
    target: frozen(target),
    targetBinding: {
      repositoryId: target.repositoryId,
      descriptorHash: target.descriptorHash,
      configDir: ".obsidian",
      historicalConfigDirs: [],
    },
    sourceRetained: true as const,
  };
}
