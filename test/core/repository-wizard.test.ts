import { describe, expect, it } from "vitest";
import {
  advanceWizardCheckpoint,
  assessRepositoryWizardLocalSafety,
  assertNormalSyncCapabilities,
  assessRepositoryJoin,
  encodeRepositoryWizardState,
  legacyPrototypeDisposition,
  parseRepositoryWizardState,
  repositoryDiscoveryStep,
  validateRepositoryDirectories,
} from "../../core/repository-wizard";
import { createReservedRootMetadata, encodeReservedRootMetadata } from "../../core/reserved-root";

describe("repository wizard", () => {
  it("requires normal immutable sync capabilities but never requires DeleteObject", () => {
    expect(() => assertNormalSyncCapabilities({ list: true, head: true, get: true, putImmutableAtomic: true, deleteObject: false })).not.toThrow();
    expect(() => assertNormalSyncCapabilities({ list: true, head: true, get: true, putImmutableAtomic: false })).toThrow("putImmutableAtomic");
  });

  it("creates, confirms, or requires explicit selection based on exact discovered repositories", () => {
    expect(repositoryDiscoveryStep([])).toEqual({ action: "create" });
    expect(repositoryDiscoveryStep(["one"])).toEqual({ action: "confirm-single", repositoryId: "one" });
    expect(repositoryDiscoveryStep(["two", "one", "two"])).toEqual({ action: "select", repositoryIds: ["one", "two"] });
  });

  it("persists monotonic checkpoints while automatic sync remains disabled", () => {
    const start = { checkpoint: "connection" as const, autoSyncDisabled: true as const, normalizedPrefix: "vault" };
    const next = advanceWizardCheckpoint(start, "repository");
    expect(next).toMatchObject({ checkpoint: "repository", autoSyncDisabled: true, normalizedPrefix: "vault" });
    expect(() => advanceWizardCheckpoint(next, "directories")).toThrow("invalid");

    const persisted = encodeRepositoryWizardState({
      checkpoint: "directories",
      autoSyncDisabled: true,
      normalizedPrefix: "vault",
      repositoryId: "123e4567-e89b-42d3-a456-426614174000",
      descriptorHash: "a".repeat(64),
      configDir: ".obsidian",
      historicalConfigDirs: [".old", ".legacy"],
    });
    expect(parseRepositoryWizardState(persisted)).toEqual({
      checkpoint: "directories",
      autoSyncDisabled: true,
      normalizedPrefix: "vault",
      repositoryId: "123e4567-e89b-42d3-a456-426614174000",
      descriptorHash: "a".repeat(64),
      configDir: ".obsidian",
      historicalConfigDirs: [".legacy", ".old"],
    });
    expect(() => parseRepositoryWizardState(persisted.replace('"autoSyncDisabled":true', '"autoSyncDisabled":false'))).toThrow("disabled");
  });

  it("rejects conflict-root aliases and requires a new generation for exact directory identity changes", () => {
    expect(() => validateRepositoryDirectories(".s3-sync-conflicts/child", [])).toThrow("conflict root");
    expect(() => validateRepositoryDirectories(".obsidian", [".OBSIDIAN"])).toThrow("aliases");
    expect(assessRepositoryJoin({ descriptorConfigDir: ".obsidian", descriptorHistoricalConfigDirs: [".old"], actualConfigDir: ".obsidian", localHistoricalConfigDirs: [".old"] })).toEqual({ status: "join" });
    expect(assessRepositoryJoin({ descriptorConfigDir: ".obsidian", descriptorHistoricalConfigDirs: [".old"], actualConfigDir: ".Obsidian", localHistoricalConfigDirs: [".local-old"] })).toMatchObject({
      status: "new-generation-required",
      configDir: ".Obsidian",
      historicalConfigDirs: [".local-old", ".old"],
    });
  });

  it("requires explicit confirmation of every verified history candidate and keeps confirmed additions", () => {
    const residualState = {
      complete: true,
      recovered: [],
      historicalConfigDirCandidates: [".obsidian", ".old"],
      issues: [],
    };
    const conflictRoot = {
      type: "directory" as const,
      metadata: encodeReservedRootMetadata(createReservedRootMetadata("vault-conflicts")),
    };
    expect(assessRepositoryWizardLocalSafety({
      actualConfigDir: ".obsidian",
      residualState,
      conflictRoot,
      pluginOwnedConfigDirs: [".legacy"],
    })).toMatchObject({
      status: "confirmation-required",
      requiredHistoricalConfigDirs: [".legacy", ".old"],
      missingConfirmations: [".legacy", ".old"],
    });
    expect(assessRepositoryWizardLocalSafety({
      actualConfigDir: ".obsidian",
      residualState,
      conflictRoot,
      pluginOwnedConfigDirs: [".legacy"],
      confirmedHistoricalConfigDirs: [".legacy", ".extra"],
    })).toMatchObject({
      status: "confirmation-required",
      proposedHistoricalConfigDirs: [".extra", ".legacy", ".old"],
      missingConfirmations: [".old"],
    });
    expect(assessRepositoryWizardLocalSafety({
      actualConfigDir: ".obsidian",
      residualState,
      conflictRoot,
      pluginOwnedConfigDirs: [".legacy"],
      confirmedHistoricalConfigDirs: [".old", ".legacy", ".extra"],
    })).toEqual({
      status: "ready",
      configDir: ".obsidian",
      historicalConfigDirs: [".extra", ".legacy", ".old"],
    });
  });

  it("blocks foreign roots, incomplete recovery, unsafe conflicts, and reserved-root directory collisions", () => {
    const incomplete = {
      complete: false,
      recovered: [],
      historicalConfigDirCandidates: [],
      issues: [
        { root: ".obsidian/.obsidian-s3-sync-local/foreign", reason: "root-refused" as const },
        { root: ".obsidian/.obsidian-s3-sync-local/missing", reason: "state-missing" as const },
      ],
    };
    expect(assessRepositoryWizardLocalSafety({
      actualConfigDir: ".obsidian",
      residualState: incomplete,
      conflictRoot: { type: "directory" },
    })).toMatchObject({
      status: "blocked",
      reasons: expect.arrayContaining([
        expect.objectContaining({ kind: "residual-state-refused" }),
        expect.objectContaining({ kind: "residual-state-incomplete" }),
        expect.objectContaining({ kind: "vault-conflict-root-refused" }),
      ]),
    });

    expect(assessRepositoryWizardLocalSafety({
      actualConfigDir: ".obsidian",
      residualState: { complete: true, recovered: [], historicalConfigDirCandidates: [], issues: [] },
      conflictRoot: { type: "missing" },
      confirmedHistoricalConfigDirs: [".s3-sync-conflicts/legacy"],
    })).toMatchObject({ status: "blocked", reasons: [expect.objectContaining({ kind: "repository-directories-invalid" })] });

    expect(assessRepositoryWizardLocalSafety({
      actualConfigDir: ".obsidian",
      residualState: { complete: true, recovered: [], historicalConfigDirCandidates: [".old"], issues: [] },
      conflictRoot: { type: "missing" },
      confirmedHistoricalConfigDirs: [".OLD"],
    })).toMatchObject({ status: "blocked", reasons: [expect.objectContaining({ kind: "repository-directories-invalid" })] });
  });

  it("requires an explicit empty-history confirmation when state loss is suspected", () => {
    const input = {
      actualConfigDir: ".obsidian",
      residualState: { complete: true, recovered: [], historicalConfigDirCandidates: [], issues: [] },
      conflictRoot: { type: "missing" as const },
      requireHistoryConfirmation: true,
    };
    expect(assessRepositoryWizardLocalSafety(input)).toMatchObject({ status: "confirmation-required" });
    expect(assessRepositoryWizardLocalSafety({ ...input, confirmedHistoricalConfigDirs: [] })).toEqual({
      status: "ready",
      configDir: ".obsidian",
      historicalConfigDirs: [],
    });
  });

  it("never offers an in-place legacy manifest upgrade", () => {
    expect(legacyPrototypeDisposition(true)).toBe("migration-instructions-only");
  });
});
