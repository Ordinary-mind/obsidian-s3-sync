import { vaultPathCaseFoldKey, normalizeVaultPath } from "./path";
import { VAULT_CONFLICT_ROOT } from "./scope";
import { normalizeProtocolPrefix } from "../protocol/keys";
import { canonicalizeProtocolJson, parseCanonicalProtocolJson } from "../protocol/json";
import {
  assessReservedRoot,
  createReservedRootMetadata,
  type ReservedRootObservation,
} from "./reserved-root";
import type { ResidualRepositoryDirectoryRecovery } from "./local-state-files";

export interface NormalSyncCapabilities {
  list: boolean;
  head: boolean;
  get: boolean;
  putImmutableAtomic: boolean;
  deleteObject?: boolean;
}

export type RepositoryDiscoveryStep =
  | { action: "create" }
  | { action: "confirm-single"; repositoryId: string }
  | { action: "select"; repositoryIds: string[] };

export type WizardCheckpoint =
  | "connection"
  | "repository"
  | "descriptor"
  | "directories"
  | "owned-roots"
  | "local-scan"
  | "confirmed";

const checkpointOrder: WizardCheckpoint[] = [
  "connection", "repository", "descriptor", "directories", "owned-roots", "local-scan", "confirmed",
];

export interface RepositoryWizardState {
  checkpoint: WizardCheckpoint;
  autoSyncDisabled: true;
  normalizedPrefix?: string;
  repositoryId?: string;
  descriptorHash?: string;
  configDir?: string;
  historicalConfigDirs?: string[];
}

export type RepositoryWizardLocalSafetyBlockReason =
  | { kind: "residual-state-refused"; paths: string[] }
  | { kind: "residual-state-incomplete"; paths: string[] }
  | { kind: "vault-conflict-root-refused"; reason: string }
  | { kind: "repository-directories-invalid"; message: string };

export type RepositoryWizardLocalSafetyAssessment =
  | {
    status: "blocked";
    reasons: RepositoryWizardLocalSafetyBlockReason[];
    requiredHistoricalConfigDirs: string[];
  }
  | {
    status: "confirmation-required";
    configDir: string;
    requiredHistoricalConfigDirs: string[];
    proposedHistoricalConfigDirs: string[];
    missingConfirmations: string[];
  }
  | { status: "ready"; configDir: string; historicalConfigDirs: string[] };

export function assertNormalSyncCapabilities(capabilities: NormalSyncCapabilities): void {
  const missing = (["list", "head", "get", "putImmutableAtomic"] as const).filter((name) => !capabilities[name]);
  if (missing.length > 0) throw new Error(`normal sync capabilities are missing: ${missing.join(", ")}`);
}

export function repositoryDiscoveryStep(repositoryIds: readonly string[]): RepositoryDiscoveryStep {
  const unique = [...new Set(repositoryIds)].sort();
  if (unique.length === 0) return { action: "create" };
  if (unique.length === 1) return { action: "confirm-single", repositoryId: unique[0] };
  return { action: "select", repositoryIds: unique };
}

export function advanceWizardCheckpoint(state: RepositoryWizardState, checkpoint: WizardCheckpoint): RepositoryWizardState {
  const normalized = normalizeWizardState(state);
  const current = checkpointOrder.indexOf(normalized.checkpoint);
  const next = checkpointOrder.indexOf(checkpoint);
  if (next !== current + 1) throw new Error(`invalid repository wizard transition: ${normalized.checkpoint} -> ${checkpoint}`);
  return normalizeWizardState({ ...normalized, checkpoint });
}

export function encodeRepositoryWizardState(state: RepositoryWizardState): string {
  return canonicalizeProtocolJson({ schemaVersion: 1, ...normalizeWizardState(state) });
}

export function parseRepositoryWizardState(source: string): RepositoryWizardState {
  const value = parseCanonicalProtocolJson(new TextEncoder().encode(source), 16 * 1024);
  const allowed = new Set([
    "schemaVersion", "checkpoint", "autoSyncDisabled", "normalizedPrefix", "repositoryId",
    "descriptorHash", "configDir", "historicalConfigDirs",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || value.schemaVersion !== 1) {
    throw new Error("repository wizard state shape is invalid");
  }
  return normalizeWizardState({
    checkpoint: value.checkpoint as WizardCheckpoint,
    autoSyncDisabled: value.autoSyncDisabled as true,
    ...(value.normalizedPrefix !== undefined ? { normalizedPrefix: requiredString(value.normalizedPrefix, "normalizedPrefix", true) } : {}),
    ...(value.repositoryId !== undefined ? { repositoryId: requiredString(value.repositoryId, "repositoryId") } : {}),
    ...(value.descriptorHash !== undefined ? { descriptorHash: requiredString(value.descriptorHash, "descriptorHash") } : {}),
    ...(value.configDir !== undefined ? { configDir: requiredString(value.configDir, "configDir") } : {}),
    ...(value.historicalConfigDirs !== undefined ? { historicalConfigDirs: requiredStringArray(value.historicalConfigDirs, "historicalConfigDirs") } : {}),
  });
}

export function validateRepositoryDirectories(configDir: string, historicalConfigDirs: readonly string[]): {
  configDir: string;
  historicalConfigDirs: string[];
} {
  const current = normalizeVaultPath(configDir);
  const histories = historicalConfigDirs.map(normalizeVaultPath).sort(compareUtf8);
  const seen = new Set<string>();
  const currentFold = vaultPathCaseFoldKey(current);
  for (const history of histories) {
    const folded = vaultPathCaseFoldKey(history);
    if (folded === currentFold) throw new Error("historical configDir aliases the current configDir");
    if (seen.has(folded)) throw new Error("historical configDirs contain a case-fold alias");
    seen.add(folded);
  }
  for (const root of [current, ...histories]) {
    if (pathsRelated(root, VAULT_CONFLICT_ROOT)) throw new Error("configDir collides with the Vault conflict root");
  }
  return { configDir: current, historicalConfigDirs: [...histories] };
}

export function assessRepositoryWizardLocalSafety(input: {
  actualConfigDir: string;
  residualState: ResidualRepositoryDirectoryRecovery;
  conflictRoot: ReservedRootObservation;
  pluginOwnedConfigDirs?: readonly string[];
  confirmedHistoricalConfigDirs?: readonly string[];
  requireHistoryConfirmation?: boolean;
}): RepositoryWizardLocalSafetyAssessment {
  const reasons: RepositoryWizardLocalSafetyBlockReason[] = [];
  const refusedPaths = input.residualState.issues
    .filter((issue) => issue.reason === "root-refused")
    .map((issue) => issue.root);
  const incompletePaths = input.residualState.issues
    .filter((issue) => issue.reason !== "root-refused")
    .map((issue) => issue.root);
  if (refusedPaths.length > 0) reasons.push({ kind: "residual-state-refused", paths: [...new Set(refusedPaths)].sort() });
  if (incompletePaths.length > 0 || (!input.residualState.complete && input.residualState.issues.length === 0)) {
    reasons.push({ kind: "residual-state-incomplete", paths: [...new Set(incompletePaths)].sort() });
  }

  const conflictRoot = assessReservedRoot(input.conflictRoot, createReservedRootMetadata("vault-conflicts"));
  if (conflictRoot.decision === "refuse") {
    reasons.push({ kind: "vault-conflict-root-refused", reason: conflictRoot.reason });
  }

  let configDir = input.actualConfigDir;
  let requiredHistoricalConfigDirs: string[] = [];
  let confirmedHistoricalConfigDirs: string[] | undefined;
  try {
    configDir = normalizeVaultPath(input.actualConfigDir);
    requiredHistoricalConfigDirs = normalizeHistoricalCandidates(configDir, [
      ...input.residualState.historicalConfigDirCandidates,
      ...(input.pluginOwnedConfigDirs ?? []),
    ]);
    if (input.confirmedHistoricalConfigDirs !== undefined) {
      confirmedHistoricalConfigDirs = normalizeHistoricalCandidates(configDir, input.confirmedHistoricalConfigDirs);
    }
  } catch (error) {
    reasons.push({
      kind: "repository-directories-invalid",
      message: error instanceof Error ? error.message : "repository directories are invalid",
    });
  }

  if (reasons.length > 0) return { status: "blocked", reasons, requiredHistoricalConfigDirs };
  if (confirmedHistoricalConfigDirs === undefined) {
    if (requiredHistoricalConfigDirs.length > 0 || input.requireHistoryConfirmation === true) {
      return {
        status: "confirmation-required",
        configDir,
        requiredHistoricalConfigDirs,
        proposedHistoricalConfigDirs: [...requiredHistoricalConfigDirs],
        missingConfirmations: [...requiredHistoricalConfigDirs],
      };
    }
    return { status: "ready", configDir, historicalConfigDirs: [] };
  }

  const confirmed = new Set(confirmedHistoricalConfigDirs);
  const missingConfirmations = requiredHistoricalConfigDirs.filter((path) => !confirmed.has(path));
  let proposedHistoricalConfigDirs: string[];
  try {
    proposedHistoricalConfigDirs = normalizeHistoricalCandidates(configDir, [
      ...requiredHistoricalConfigDirs,
      ...confirmedHistoricalConfigDirs,
    ]);
  } catch (error) {
    return {
      status: "blocked",
      reasons: [{
        kind: "repository-directories-invalid",
        message: error instanceof Error ? error.message : "repository directories are invalid",
      }],
      requiredHistoricalConfigDirs,
    };
  }
  if (missingConfirmations.length > 0) {
    return {
      status: "confirmation-required",
      configDir,
      requiredHistoricalConfigDirs,
      proposedHistoricalConfigDirs,
      missingConfirmations,
    };
  }
  return { status: "ready", configDir, historicalConfigDirs: proposedHistoricalConfigDirs };
}

export type RepositoryJoinAssessment =
  | { status: "join" }
  | { status: "new-generation-required"; configDir: string; historicalConfigDirs: string[]; reasons: string[] };

export function assessRepositoryJoin(input: {
  descriptorConfigDir: string;
  descriptorHistoricalConfigDirs: readonly string[];
  actualConfigDir: string;
  localHistoricalConfigDirs: readonly string[];
}): RepositoryJoinAssessment {
  const descriptor = validateRepositoryDirectories(input.descriptorConfigDir, input.descriptorHistoricalConfigDirs);
  const local = validateRepositoryDirectories(input.actualConfigDir, input.localHistoricalConfigDirs);
  const reasons: string[] = [];
  if (local.configDir !== descriptor.configDir) reasons.push("actual configDir differs from RepositoryDescriptor");
  const descriptorHistories = new Set(descriptor.historicalConfigDirs);
  const missingHistories = local.historicalConfigDirs.filter((path) => !descriptorHistories.has(path));
  if (missingHistories.length > 0) reasons.push("local historical configDir is absent from RepositoryDescriptor");
  if (reasons.length === 0) return { status: "join" };
  return {
    status: "new-generation-required",
    configDir: local.configDir,
    historicalConfigDirs: unionDirectories([
      descriptor.configDir,
      ...descriptor.historicalConfigDirs,
      ...local.historicalConfigDirs,
    ], local.configDir),
    reasons,
  };
}

export function legacyPrototypeDisposition(legacyManifestPresent: boolean): "none" | "migration-instructions-only" {
  return legacyManifestPresent ? "migration-instructions-only" : "none";
}

function unionDirectories(paths: readonly string[], current: string): string[] {
  const currentFold = vaultPathCaseFoldKey(current);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const normalized = normalizeVaultPath(path);
    const folded = vaultPathCaseFoldKey(normalized);
    if (folded === currentFold || seen.has(folded)) continue;
    seen.add(folded);
    result.push(normalized);
  }
  return result.sort(compareUtf8);
}

function pathsRelated(left: string, right: string): boolean {
  const leftKey = vaultPathCaseFoldKey(left);
  const rightKey = vaultPathCaseFoldKey(right);
  return leftKey === rightKey || leftKey.startsWith(`${rightKey}/`) || rightKey.startsWith(`${leftKey}/`);
}

function normalizeWizardState(state: RepositoryWizardState): RepositoryWizardState {
  if (!checkpointOrder.includes(state.checkpoint) || state.autoSyncDisabled !== true) {
    throw new Error("repository wizard must keep automatic sync disabled");
  }
  const result: RepositoryWizardState = { checkpoint: state.checkpoint, autoSyncDisabled: true };
  if (state.normalizedPrefix !== undefined) {
    const normalizedPrefix = normalizeProtocolPrefix(state.normalizedPrefix);
    if (normalizedPrefix !== state.normalizedPrefix) throw new Error("repository wizard Prefix is not normalized");
    result.normalizedPrefix = normalizedPrefix;
  }
  if (state.repositoryId !== undefined) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(state.repositoryId)) {
      throw new Error("repository wizard repositoryId is invalid");
    }
    result.repositoryId = state.repositoryId;
  }
  if (state.descriptorHash !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(state.descriptorHash)) throw new Error("repository wizard descriptorHash is invalid");
    result.descriptorHash = state.descriptorHash;
  }
  if ((state.configDir === undefined) !== (state.historicalConfigDirs === undefined)) {
    throw new Error("repository wizard directory checkpoint is incomplete");
  }
  if (state.configDir !== undefined && state.historicalConfigDirs !== undefined) {
    const directories = validateRepositoryDirectories(state.configDir, state.historicalConfigDirs);
    result.configDir = directories.configDir;
    result.historicalConfigDirs = directories.historicalConfigDirs;
  }
  return result;
}

function normalizeHistoricalCandidates(current: string, paths: readonly string[]): string[] {
  const exact = new Set<string>();
  const histories: string[] = [];
  const currentFold = vaultPathCaseFoldKey(current);
  for (const path of paths) {
    const normalized = normalizeVaultPath(path);
    if (normalized === current || exact.has(normalized)) continue;
    if (vaultPathCaseFoldKey(normalized) === currentFold) {
      throw new Error("historical configDir aliases the current configDir");
    }
    exact.add(normalized);
    histories.push(normalized);
  }
  return validateRepositoryDirectories(current, histories).historicalConfigDirs;
}

function requiredString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw new Error(`repository wizard ${name} is invalid`);
  return value;
}

function requiredStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`repository wizard ${name} is invalid`);
  }
  return [...value] as string[];
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}
