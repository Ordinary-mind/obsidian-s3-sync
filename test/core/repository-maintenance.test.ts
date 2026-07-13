import { describe, expect, it } from "vitest";
import { calculateRepositorySpaceStatistics, orphanMaintenanceDisposition } from "../../core/repository-statistics";
import { assertMaintenanceDeletionAuthorized, buildRepositoryGenerationPlan, inPlaceGarbageCollectionDisposition, mayMigrateGeneration, recordGenerationAudit, validateProtocolLifecycleRule } from "../../core/maintenance-plan";

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
    expect(stats).toMatchObject({ uniqueBytes: 100, dedupSavedBytes: 50, orphanKeys: ["orphan"] });
    expect(stats.estimatedRequestCost).toBeCloseTo(0.00022);
    expect(orphanMaintenanceDisposition()).toBe("report-only-no-automatic-delete");
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

  it("requires separate maintenance permission, complete audits and two confirmations for deletion", () => {
    expect(() => assertMaintenanceDeletionAuthorized({ sourceAuditComplete: true, targetAuditComplete: true, hasMaintenanceDeleteCapability: false, firstConfirmation: true, secondConfirmation: true })).toThrow("capability");
    expect(() => assertMaintenanceDeletionAuthorized({ sourceAuditComplete: true, targetAuditComplete: true, hasMaintenanceDeleteCapability: true, firstConfirmation: true, secondConfirmation: true })).not.toThrow();
    expect(inPlaceGarbageCollectionDisposition()).toBe("prohibited-without-multi-device-fault-proof");
  });

  it("rejects LastModified expiration rules covering the protocol root", () => {
    expect(() => validateProtocolLifecycleRule({ rulePrefix: "vault", protocolRoot: "vault/.obsidian-s3-sync/v1", expiresByLastModified: true })).toThrow("LastModified");
    expect(() => validateProtocolLifecycleRule({ rulePrefix: "vault/tmp", protocolRoot: "vault/.obsidian-s3-sync/v1", expiresByLastModified: true })).not.toThrow();
  });
});
