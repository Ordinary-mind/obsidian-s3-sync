import { canonicalizeProtocolJson } from "../protocol/json";

export interface LocalOnboardingFile {
  path: string;
  hash: string;
  size: number;
  stagedRef: string;
}

export type RemoteOnboardingHead =
  | { versionId: string; kind: "put"; hash: string; size: number }
  | { versionId: string; kind: "delete" };

export interface RemoteOnboardingRegister {
  path: string;
  heads: RemoteOnboardingHead[];
}

export type VaultOnboardingAction =
  | { kind: "publish-local-root"; path: string; local: LocalOnboardingFile; parents: [] }
  | { kind: "project-remote-put"; path: string; head: Extract<RemoteOnboardingHead, { kind: "put" }>; equivalentHeads: string[] }
  | { kind: "adopt-remote-delete"; path: string; equivalentHeads: string[] }
  | { kind: "adopt-equivalent"; path: string; hash: string; equivalentHeads: string[]; remoteConflictRemains: boolean }
  | { kind: "show-remote-conflict"; path: string; heads: RemoteOnboardingHead[] }
  | { kind: "publish-local-root-conflict"; path: string; local: LocalOnboardingFile; parents: []; remoteHeads: string[]; requiresConfirmation: true };

export interface VaultOnboardingPlan {
  actions: VaultOnboardingAction[];
  localWasEmpty: boolean;
  remoteWasEmpty: boolean;
  requiresConfirmation: boolean;
}

export interface VaultOnboardingPrePublishReview {
  initialPlan: VaultOnboardingPlan;
  plan: VaultOnboardingPlan;
  remoteChanged: boolean;
}

export function planVaultOnboarding(
  localFiles: readonly LocalOnboardingFile[],
  remoteRegisters: readonly RemoteOnboardingRegister[],
): VaultOnboardingPlan {
  const local = uniqueByPath(localFiles, "local onboarding");
  const remote = uniqueByPath(remoteRegisters, "remote onboarding");
  const paths = [...new Set([...local.keys(), ...remote.keys()])].sort();
  const actions: VaultOnboardingAction[] = [];
  for (const path of paths) {
    const localFile = local.get(path);
    const register = remote.get(path);
    if (!register || register.heads.length === 0) {
      if (localFile) actions.push({ kind: "publish-local-root", path, local: { ...localFile }, parents: [] });
      continue;
    }
    assertUniqueHeads(register.heads);
    const semanticGroups = groupHeads(register.heads);
    if (!localFile) {
      if (semanticGroups.length !== 1) {
        actions.push({ kind: "show-remote-conflict", path, heads: copyHeads(register.heads) });
      } else if (semanticGroups[0].kind === "delete") {
        actions.push({ kind: "adopt-remote-delete", path, equivalentHeads: semanticGroups[0].versionIds });
      } else {
        const group = semanticGroups[0];
        const head = register.heads.find((candidate): candidate is Extract<RemoteOnboardingHead, { kind: "put" }> => candidate.kind === "put" && candidate.hash === group.hash)!;
        actions.push({ kind: "project-remote-put", path, head: { ...head }, equivalentHeads: group.versionIds });
      }
      continue;
    }
    const matching = semanticGroups.find((group) => group.kind === "put" && group.hash === localFile.hash);
    if (matching) {
      actions.push({ kind: "adopt-equivalent", path, hash: localFile.hash, equivalentHeads: matching.versionIds, remoteConflictRemains: semanticGroups.length > 1 });
      continue;
    }
    actions.push({
      kind: "publish-local-root-conflict",
      path,
      local: { ...localFile },
      parents: [],
      remoteHeads: register.heads.map((head) => head.versionId).sort(),
      requiresConfirmation: true,
    });
  }
  return {
    actions,
    localWasEmpty: local.size === 0,
    remoteWasEmpty: remote.size === 0,
    requiresConfirmation: actions.some((action) => action.kind === "publish-local-root-conflict"),
  };
}

export function revalidateVaultOnboardingBeforePublish(
  frozenLocalFiles: readonly LocalOnboardingFile[],
  initialRemoteRegisters: readonly RemoteOnboardingRegister[],
  latestRemoteRegisters: readonly RemoteOnboardingRegister[],
): VaultOnboardingPrePublishReview {
  const initialPlan = planVaultOnboarding(frozenLocalFiles, initialRemoteRegisters);
  const plan = planVaultOnboarding(frozenLocalFiles, latestRemoteRegisters);
  return {
    initialPlan,
    plan,
    remoteChanged: remoteRegistersSignature(initialRemoteRegisters) !== remoteRegistersSignature(latestRemoteRegisters),
  };
}

export type ExistingLocalCloneDecision =
  | { action: "safe-onboarding" }
  | { action: "move-all-to-recovery-and-clone"; requiresSecondConfirmation: true }
  | { action: "create-new-repository-generation" };

export function explicitOnboardingOverride(action: "normal" | "clone-remote" | "replace-remote"): ExistingLocalCloneDecision {
  if (action === "clone-remote") return { action: "move-all-to-recovery-and-clone", requiresSecondConfirmation: true };
  if (action === "replace-remote") return { action: "create-new-repository-generation" };
  return { action: "safe-onboarding" };
}

type SemanticGroup =
  | { kind: "put"; hash: string; versionIds: string[] }
  | { kind: "delete"; versionIds: string[] };

function groupHeads(heads: readonly RemoteOnboardingHead[]): SemanticGroup[] {
  const groups = new Map<string, RemoteOnboardingHead[]>();
  for (const head of heads) {
    const key = head.kind === "delete" ? "delete" : `put:${head.hash}`;
    const group = groups.get(key) ?? [];
    group.push(head);
    groups.set(key, group);
  }
  return [...groups.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, values]) => {
    const versionIds = values.map((value) => value.versionId).sort();
    return key === "delete" ? { kind: "delete", versionIds } : { kind: "put", hash: key.slice(4), versionIds };
  });
}

function uniqueByPath<T extends { path: string }>(values: readonly T[], label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (result.has(value.path)) throw new Error(`${label} contains duplicate path`);
    result.set(value.path, value);
  }
  return result;
}

function assertUniqueHeads(heads: readonly RemoteOnboardingHead[]): void {
  if (new Set(heads.map((head) => head.versionId)).size !== heads.length) throw new Error("remote onboarding contains duplicate heads");
}

function copyHeads(heads: readonly RemoteOnboardingHead[]): RemoteOnboardingHead[] {
  return heads.map((head) => ({ ...head })).sort((left, right) => left.versionId < right.versionId ? -1 : left.versionId > right.versionId ? 1 : 0);
}

function remoteRegistersSignature(registers: readonly RemoteOnboardingRegister[]): string {
  const unique = uniqueByPath(registers, "remote onboarding");
  const normalized = [...unique.values()]
    .map((register) => {
      assertUniqueHeads(register.heads);
      return { path: register.path, heads: copyHeads(register.heads) };
    })
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return canonicalizeProtocolJson(normalized);
}
