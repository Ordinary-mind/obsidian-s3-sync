import { vaultPathCaseFoldKey } from "./path";
import { protocolRoot } from "../protocol/keys";
import type { RemoteAuditResult } from "./remote-audit";
import type { RepositoryGenerationMigrationResult } from "./repository-generation";
import { validateRepositoryDirectories } from "./repository-wizard";

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
  const sourceDirectories = validateRepositoryDirectories(input.sourceConfigDir, input.sourceHistoricalConfigDirs);
  const targetConfigDir = validateRepositoryDirectories(input.targetConfigDir, []).configDir;
  const histories = uniqueCaseFold([
    sourceDirectories.configDir,
    ...sourceDirectories.historicalConfigDirs,
    ...input.participantHistoricalConfigDirs,
  ], targetConfigDir);
  const targetDirectories = validateRepositoryDirectories(targetConfigDir, histories);
  const sourceExcludedRoots = [sourceDirectories.configDir, ...sourceDirectories.historicalConfigDirs];
  const targetExcludedRoots = [targetDirectories.configDir, ...targetDirectories.historicalConfigDirs];
  const added = targetExcludedRoots.filter((path) => !sourceExcludedRoots
    .some((existing) => vaultPathCaseFoldKey(existing) === vaultPathCaseFoldKey(path)));
  const blockingVersions = input.sourceVaultHeads
    .filter((head) => added.some((root) => pathsRelated(head.path, root)))
    .map((head) => ({ ...head }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : left.versionId < right.versionId ? -1 : 1);
  return {
    sourceRepositoryId: input.sourceRepositoryId,
    targetRepositoryId: input.targetRepositoryId,
    sourceFrozen: true,
    targetConfigDir: targetDirectories.configDir,
    targetHistoricalConfigDirs: targetDirectories.historicalConfigDirs,
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

export interface MaintenanceDeleteCapability {
  kind: "repository-maintenance-delete";
  credentialId: string;
  repositoryId: string;
  scopePrefix: string;
  deleteObject: true;
}

export interface MaintenanceDeletionConfirmation {
  confirmationId: string;
  challenge: string;
  confirmedAt: number;
}

export interface MaintenanceDeletionAuthorization {
  sourceRepositoryId: string;
  sourceDescriptorHash: string;
  targetRepositoryId: string;
  targetDescriptorHash: string;
  credentialId: string;
  scopePrefix: string;
  authorizedAt: number;
  confirmationIds: readonly [string, string];
}

export function maintenanceDeletionChallenge(sourceRepositoryId: string, targetRepositoryId: string): string {
  if (!sourceRepositoryId || !targetRepositoryId || sourceRepositoryId === targetRepositoryId) {
    throw new Error("maintenance deletion requires distinct source and target repositories");
  }
  return `DELETE SOURCE ${sourceRepositoryId} AFTER VERIFYING TARGET ${targetRepositoryId}`;
}

export function authorizeMaintenanceDeletion(input: {
  prefix: string;
  sourceAudit: RemoteAuditResult;
  targetAudit: RemoteAuditResult;
  migration: Extract<RepositoryGenerationMigrationResult, { status: "migrated" }>;
  normalSyncCredentialId: string;
  capability: MaintenanceDeleteCapability;
  firstConfirmation: MaintenanceDeletionConfirmation;
  secondConfirmation: MaintenanceDeletionConfirmation;
}): Readonly<MaintenanceDeletionAuthorization> {
  assertCompleteMaintenanceAudit(input.sourceAudit, "source");
  assertCompleteMaintenanceAudit(input.targetAudit, "target");
  if (input.sourceAudit.repositoryId === input.targetAudit.repositoryId) {
    throw new Error("maintenance deletion requires a separately verified target generation");
  }
  if (input.migration.source.repositoryId !== input.sourceAudit.repositoryId
    || input.migration.source.descriptorHash !== input.sourceAudit.descriptorHash
    || input.migration.target.repositoryId !== input.targetAudit.repositoryId
    || input.migration.target.descriptorHash !== input.targetAudit.descriptorHash
    || !sameStringSet(input.migration.source.commitKeys, input.sourceAudit.commitKeys)
    || !sameStringSet(input.migration.target.commitKeys, input.targetAudit.commitKeys)
    || input.migration.source.logicalStateHash !== input.migration.target.logicalStateHash
    || !input.migration.sourceRetained) {
    throw new Error("maintenance deletion requires the verified equivalent repository generation migration");
  }
  const sourceRoot = protocolRoot(input.prefix, input.sourceAudit.repositoryId);
  const capabilityRoot = trim(input.capability.scopePrefix);
  if (input.capability.kind !== "repository-maintenance-delete" || !input.capability.deleteObject
    || input.capability.repositoryId !== input.sourceAudit.repositoryId || capabilityRoot !== sourceRoot) {
    throw new Error("maintenance DeleteObject capability is not bound to the source repository generation");
  }
  if (!input.capability.credentialId || input.capability.credentialId === input.normalSyncCredentialId) {
    throw new Error("maintenance deletion requires credentials independent from normal synchronization");
  }
  const expected = maintenanceDeletionChallenge(input.sourceAudit.repositoryId, input.targetAudit.repositoryId);
  const confirmations = [input.firstConfirmation, input.secondConfirmation] as const;
  if (confirmations.some((confirmation) => confirmation.challenge !== expected
    || !confirmation.confirmationId || !Number.isSafeInteger(confirmation.confirmedAt) || confirmation.confirmedAt < 0)) {
    throw new Error("maintenance deletion confirmation is invalid");
  }
  if (input.firstConfirmation.confirmationId === input.secondConfirmation.confirmationId
    || input.secondConfirmation.confirmedAt < input.firstConfirmation.confirmedAt) {
    throw new Error("maintenance deletion requires two ordered independent confirmations");
  }
  return Object.freeze({
    sourceRepositoryId: input.sourceAudit.repositoryId,
    sourceDescriptorHash: input.sourceAudit.descriptorHash,
    targetRepositoryId: input.targetAudit.repositoryId,
    targetDescriptorHash: input.targetAudit.descriptorHash,
    credentialId: input.capability.credentialId,
    scopePrefix: sourceRoot,
    authorizedAt: input.secondConfirmation.confirmedAt,
    confirmationIds: Object.freeze([
      input.firstConfirmation.confirmationId,
      input.secondConfirmation.confirmationId,
    ]) as readonly [string, string],
  });
}

export function validateProtocolLifecycleRule(input: { rulePrefix: string; protocolRoot: string; expiresByLastModified: boolean }): void {
  const rule = trim(input.rulePrefix); const root = trim(input.protocolRoot);
  const overlapsRoot = root === rule || root.startsWith(`${rule}/`) || rule.startsWith(`${root}/`) || rule === "";
  if (input.expiresByLastModified && overlapsRoot) throw new Error("LastModified expiration must not cover immutable protocol objects");
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

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function assertCompleteMaintenanceAudit(audit: RemoteAuditResult, side: "source" | "target"): void {
  if (!audit.repositoryId || !/^[0-9a-f]{64}$/.test(audit.descriptorHash)
    || audit.status !== "complete" || !audit.deletionEvidenceAllowed
    || audit.missingClosure.length > 0 || audit.verifiedObjects !== audit.totalObjects) {
    throw new Error(`maintenance deletion requires a complete ${side} reachable-object audit`);
  }
}
