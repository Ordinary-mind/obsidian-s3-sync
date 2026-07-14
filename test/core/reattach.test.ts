import { describe, expect, it } from "vitest";
import { decideStateLossRecovery, planStateLossRecovery } from "../../core/reattach";

describe("state-loss reattachment", () => {
  it("never treats a non-empty local Vault as safe for automatic rebuild", () => {
    expect(decideStateLossRecovery(false)).toBe("rebuild-empty-local");
    expect(decideStateLossRecovery(true)).toBe("require-non-destructive-onboarding");
  });

  it("routes modified local content through unconfirmed root onboarding after state loss", () => {
    const plan = planStateLossRecovery({
      localFiles: [{ path: "a.md", hash: "a".repeat(64), size: 1, stagedRef: "staged/a" }],
      remoteRegisters: [{
        path: "a.md",
        heads: [{ versionId: `${"1".repeat(64)}:0:0`, kind: "put", hash: "b".repeat(64), size: 1 }],
      }],
    });
    expect(plan).toMatchObject({
      entrypoint: "non-destructive-onboarding",
      strategy: "require-non-destructive-onboarding",
      autoSyncDisabled: true,
      projectionConfirmationRequired: true,
      publicationAuthorized: false,
      destructiveApplyAuthorized: false,
      onboarding: { actions: [{ kind: "publish-local-root-conflict", parents: [] }] },
    });
  });

  it("does not infer a tombstone from local absence and retains unfinished recovery evidence", () => {
    const remoteOnly = planStateLossRecovery({
      localFiles: [],
      remoteRegisters: [{
        path: "remote.md",
        heads: [{ versionId: `${"2".repeat(64)}:0:0`, kind: "put", hash: "c".repeat(64), size: 1 }],
      }],
    });
    expect(remoteOnly.strategy).toBe("rebuild-empty-local");
    expect(remoteOnly.onboarding.actions).toEqual([expect.objectContaining({ kind: "project-remote-put" })]);
    expect(remoteOnly.onboarding.actions.some((action) => action.kind === "publish-local-root")).toBe(false);

    const unfinishedRecovery = planStateLossRecovery({
      localFiles: [],
      remoteRegisters: [],
      pendingRecoveryFiles: ["recovery/two", "recovery/one", "recovery/two"],
    });
    expect(unfinishedRecovery).toMatchObject({
      strategy: "require-non-destructive-onboarding",
      pendingRecoveryFiles: ["recovery/one", "recovery/two"],
      publicationAuthorized: false,
      destructiveApplyAuthorized: false,
    });
  });

  it("rebuilds an empty Vault from remote state while forcing non-empty Vaults through reattachment", () => {
    const remoteRegisters = [{
      path: "remote.md",
      heads: [{ versionId: `${"2".repeat(64)}:0:0`, kind: "put" as const, hash: "c".repeat(64), size: 1 }],
    }];
    const empty = planStateLossRecovery({ localFiles: [], remoteRegisters });
    expect(empty).toMatchObject({
      strategy: "rebuild-empty-local",
      publicationAuthorized: false,
      destructiveApplyAuthorized: false,
      onboarding: { actions: [{ kind: "project-remote-put" }] },
    });

    const nonEmpty = planStateLossRecovery({
      localFiles: [{ path: "local.md", hash: "d".repeat(64), size: 1, stagedRef: "staged/local" }],
      remoteRegisters,
    });
    expect(nonEmpty).toMatchObject({
      strategy: "require-non-destructive-onboarding",
      autoSyncDisabled: true,
      projectionConfirmationRequired: true,
      publicationAuthorized: false,
      destructiveApplyAuthorized: false,
    });
  });
});
