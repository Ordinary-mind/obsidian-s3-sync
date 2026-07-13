import { vaultPathCaseFoldKey, normalizeVaultPath } from "./path";
import { VAULT_CONFLICT_ROOT } from "./scope";

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
}

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
  const current = checkpointOrder.indexOf(state.checkpoint);
  const next = checkpointOrder.indexOf(checkpoint);
  if (next !== current + 1) throw new Error(`invalid repository wizard transition: ${state.checkpoint} -> ${checkpoint}`);
  return { ...state, checkpoint };
}

export function validateRepositoryDirectories(configDir: string, historicalConfigDirs: readonly string[]): {
  configDir: string;
  historicalConfigDirs: string[];
} {
  const current = normalizeVaultPath(configDir);
  const histories = historicalConfigDirs.map(normalizeVaultPath);
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
  return result;
}

function pathsRelated(left: string, right: string): boolean {
  const leftKey = vaultPathCaseFoldKey(left);
  const rightKey = vaultPathCaseFoldKey(right);
  return leftKey === rightKey || leftKey.startsWith(`${rightKey}/`) || rightKey.startsWith(`${leftKey}/`);
}
