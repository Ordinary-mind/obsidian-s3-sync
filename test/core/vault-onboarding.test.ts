import { describe, expect, it } from "vitest";
import {
  explicitOnboardingOverride,
  planVaultOnboarding,
  revalidateVaultOnboardingBeforePublish,
  type LocalOnboardingFile,
  type RemoteOnboardingRegister,
} from "../../core/vault-onboarding";

const local = (path: string, hash: string): LocalOnboardingFile => ({ path, hash, size: 1, stagedRef: `staged/${hash}` });
const remotePut = (path: string, hash: string, versionId = `${hash}:0:0`): RemoteOnboardingRegister => ({ path, heads: [{ versionId, kind: "put", hash, size: 1 }] });
const remoteDelete = (path: string, versionId = `${"d".repeat(64)}:0:0`): RemoteOnboardingRegister => ({ path, heads: [{ versionId, kind: "delete" }] });

describe("Vault non-destructive onboarding", () => {
  it("covers remote/local empty combinations without inventing deletion parents", () => {
    expect(planVaultOnboarding([], [])).toEqual({ actions: [], localWasEmpty: true, remoteWasEmpty: true, requiresConfirmation: false });
    expect(planVaultOnboarding([local("local.md", "a".repeat(64))], []).actions[0]).toMatchObject({ kind: "publish-local-root", parents: [] });
    expect(planVaultOnboarding([], [remotePut("remote.md", "b".repeat(64))]).actions[0]).toMatchObject({ kind: "project-remote-put" });
    expect(planVaultOnboarding([], [remoteDelete("gone.md")]).actions[0]).toMatchObject({ kind: "adopt-remote-delete" });
  });

  it("adopts all equivalent heads and never marks one value as winner of an existing conflict", () => {
    const same = "a".repeat(64);
    const other = "b".repeat(64);
    const register: RemoteOnboardingRegister = {
      path: "a.md",
      heads: [
        { versionId: `${"1".repeat(64)}:0:0`, kind: "put", hash: same, size: 1 },
        { versionId: `${"2".repeat(64)}:0:0`, kind: "put", hash: same, size: 1 },
        { versionId: `${"3".repeat(64)}:0:0`, kind: "put", hash: other, size: 1 },
      ],
    };
    expect(planVaultOnboarding([local("a.md", same)], [register]).actions[0]).toMatchObject({
      kind: "adopt-equivalent",
      equivalentHeads: [`${"1".repeat(64)}:0:0`, `${"2".repeat(64)}:0:0`],
      remoteConflictRemains: true,
    });
    expect(planVaultOnboarding([], [register]).actions[0]).toMatchObject({ kind: "show-remote-conflict" });
  });

  it("publishes distinct local content as a confirmed root conflict, including against a tombstone", () => {
    const result = planVaultOnboarding(
      [local("a.md", "a".repeat(64)), local("gone.md", "c".repeat(64))],
      [remotePut("a.md", "b".repeat(64)), remoteDelete("gone.md")],
    );
    expect(result.requiresConfirmation).toBe(true);
    expect(result.actions).toHaveLength(2);
    for (const action of result.actions) expect(action).toMatchObject({ kind: "publish-local-root-conflict", parents: [], requiresConfirmation: true });
  });

  it("requires recovery plus second confirmation for cloning over existing local content and a new generation for replacement", () => {
    expect(explicitOnboardingOverride("clone-remote")).toEqual({ action: "move-all-to-recovery-and-clone", requiresSecondConfirmation: true });
    expect(explicitOnboardingOverride("replace-remote")).toEqual({ action: "create-new-repository-generation" });
  });

  it("re-pulls before publication without assigning remote heads as parents of a frozen local root", () => {
    const frozen = [local("a.md", "a".repeat(64))];
    const concurrent = revalidateVaultOnboardingBeforePublish(
      frozen,
      [],
      [remotePut("a.md", "b".repeat(64), `${"1".repeat(64)}:0:0`)],
    );
    expect(concurrent).toMatchObject({ remoteChanged: true, initialPlan: { actions: [{ kind: "publish-local-root", parents: [] }] } });
    expect(concurrent.plan.actions).toEqual([
      expect.objectContaining({
        kind: "publish-local-root-conflict",
        parents: [],
        remoteHeads: [`${"1".repeat(64)}:0:0`],
        requiresConfirmation: true,
      }),
    ]);

    const equivalent = revalidateVaultOnboardingBeforePublish(
      frozen,
      [],
      [remotePut("a.md", "a".repeat(64), `${"2".repeat(64)}:0:0`)],
    );
    expect(equivalent.plan.actions).toEqual([
      expect.objectContaining({ kind: "adopt-equivalent", equivalentHeads: [`${"2".repeat(64)}:0:0`] }),
    ]);
  });
});
