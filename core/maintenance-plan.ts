import { vaultPathCaseFoldKey } from "./path";

export interface SourceVaultHead {
  path: string;
  versionId: string;
}

export interface RepositoryGenerationPlan {
  sourceRepositoryId: string;
  targetRepositoryId: string;
  sourceFrozen: true;
  targetConfigDir: string;
  targetHistoricalConfigDirs: string[];
  blockingVersions: SourceVaultHead[];
  phases: readonly ["freeze-source", "write-target", "verify-source-and-target", "migrate-devices", "retain-source"];
  sourceAuditComplete: boolean;
  targetAuditComplete: boolean;
}

export function buildRepositoryGenerationPlan(input: {
  sourceRepositoryId: string;
  targetRepositoryId: string;
  sourceConfigDir: string;
  sourceHistoricalConfigDirs: readonly string[];
  targetConfigDir: string;
  participantHistoricalConfigDirs: readonly string[];
  sourceVaultHeads: readonly SourceVaultHead[];
}): RepositoryGenerationPlan {
  if (input.sourceRepositoryId === input.targetRepositoryId) throw new Error("maintenance requires a new repositoryId");
  const histories = uniqueCaseFold([
    input.sourceConfigDir,
    ...input.sourceHistoricalConfigDirs,
    ...input.participantHistoricalConfigDirs,
  ], input.targetConfigDir);
  const added = histories.filter((path) => ![input.sourceConfigDir, ...input.sourceHistoricalConfigDirs]
    .some((existing) => vaultPathCaseFoldKey(existing) === vaultPathCaseFoldKey(path)));
  const blockingVersions = input.sourceVaultHeads
    .filter((head) => added.some((root) => pathsRelated(head.path, root)))
    .map((head) => ({ ...head }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : left.versionId < right.versionId ? -1 : 1);
  return {
    sourceRepositoryId: input.sourceRepositoryId,
    targetRepositoryId: input.targetRepositoryId,
    sourceFrozen: true,
    targetConfigDir: input.targetConfigDir,
    targetHistoricalConfigDirs: histories,
    blockingVersions,
    phases: ["freeze-source", "write-target", "verify-source-and-target", "migrate-devices", "retain-source"],
    sourceAuditComplete: false,
    targetAuditComplete: false,
  };
}

export function recordGenerationAudit(plan: RepositoryGenerationPlan, repository: "source" | "target", complete: boolean): RepositoryGenerationPlan {
  if (!complete) return plan;
  return repository === "source" ? { ...plan, sourceAuditComplete: true } : { ...plan, targetAuditComplete: true };
}

export function mayMigrateGeneration(plan: RepositoryGenerationPlan): boolean {
  return plan.blockingVersions.length === 0 && plan.sourceAuditComplete && plan.targetAuditComplete;
}

export function assertMaintenanceDeletionAuthorized(input: {
  sourceAuditComplete: boolean;
  targetAuditComplete: boolean;
  hasMaintenanceDeleteCapability: boolean;
  firstConfirmation: boolean;
  secondConfirmation: boolean;
}): void {
  if (!input.sourceAuditComplete || !input.targetAuditComplete) throw new Error("maintenance deletion requires complete source and target audits");
  if (!input.hasMaintenanceDeleteCapability) throw new Error("maintenance DeleteObject capability is absent");
  if (!input.firstConfirmation || !input.secondConfirmation) throw new Error("maintenance deletion requires two confirmations");
}

export function validateProtocolLifecycleRule(input: { rulePrefix: string; protocolRoot: string; expiresByLastModified: boolean }): void {
  const rule = trim(input.rulePrefix); const root = trim(input.protocolRoot);
  const coversRoot = root === rule || root.startsWith(`${rule}/`) || rule === "";
  if (input.expiresByLastModified && coversRoot) throw new Error("LastModified expiration must not cover immutable protocol objects");
}

export function inPlaceGarbageCollectionDisposition(): "prohibited-without-multi-device-fault-proof" {
  return "prohibited-without-multi-device-fault-proof";
}

function uniqueCaseFold(paths: readonly string[], current: string): string[] {
  const currentKey = vaultPathCaseFoldKey(current);
  const seen = new Set<string>(); const result: string[] = [];
  for (const path of paths) {
    const key = vaultPathCaseFoldKey(path);
    if (key === currentKey || seen.has(key)) continue;
    seen.add(key); result.push(path);
  }
  return result;
}

function pathsRelated(left: string, right: string): boolean {
  const a = vaultPathCaseFoldKey(left); const b = vaultPathCaseFoldKey(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
function trim(value: string): string { return value.replace(/^\/+|\/+$/g, ""); }
