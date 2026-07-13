import { describe, expect, it } from "vitest";
import {
  advanceWizardCheckpoint,
  assertNormalSyncCapabilities,
  assessRepositoryJoin,
  legacyPrototypeDisposition,
  repositoryDiscoveryStep,
  validateRepositoryDirectories,
} from "../../core/repository-wizard";

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
  });

  it("rejects conflict-root aliases and requires a new generation for exact directory identity changes", () => {
    expect(() => validateRepositoryDirectories(".s3-sync-conflicts/child", [])).toThrow("conflict root");
    expect(() => validateRepositoryDirectories(".obsidian", [".OBSIDIAN"])).toThrow("aliases");
    expect(assessRepositoryJoin({ descriptorConfigDir: ".obsidian", descriptorHistoricalConfigDirs: [".old"], actualConfigDir: ".obsidian", localHistoricalConfigDirs: [".old"] })).toEqual({ status: "join" });
    expect(assessRepositoryJoin({ descriptorConfigDir: ".obsidian", descriptorHistoricalConfigDirs: [".old"], actualConfigDir: ".Obsidian", localHistoricalConfigDirs: [".local-old"] })).toMatchObject({
      status: "new-generation-required",
      configDir: ".Obsidian",
      historicalConfigDirs: [".old", ".local-old"],
    });
  });

  it("never offers an in-place legacy manifest upgrade", () => {
    expect(legacyPrototypeDisposition(true)).toBe("migration-instructions-only");
  });
});
