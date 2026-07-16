import type { RepositoryLocator } from "./locator";

export interface CredentialStorage {
  kind: "plaintext";
  accessKeyId: string;
  secretAccessKey: string;
}

export const PLUGIN_DATA_SCHEMA_VERSION = 4 as const;

export interface PersistedRepositorySelection {
  repositoryId: string;
  descriptorHash: string;
  repositoryFingerprint: string;
  locator: RepositoryLocator;
  configDir: string;
  historicalConfigDirs: string[];
}

export interface PluginDataEnvelope<TPreferences extends Record<string, unknown>> {
  schemaVersion: typeof PLUGIN_DATA_SCHEMA_VERSION;
  connection: {
    endpoint: string;
    region: string;
    bucket: string;
    normalizedPrefix: string;
    forcePathStyle: boolean;
    credentials: CredentialStorage;
  };
  repositorySelection?: PersistedRepositorySelection;
  preferences: TPreferences;
}

export function plaintextCredentialWarning(): string {
  return "当前平台没有可用的 secret provider；S3 凭证将以明文保存在插件 data.json 中。";
}

export function effectivePersistedRepositoryPrefix(persistedPrefix: string | undefined, unboundPrefix: string): string {
  return persistedPrefix ?? unboundPrefix;
}

export function assertPluginDataContainsNoOperationalState(value: unknown): void {
  if (!isRecord(value)) throw new Error("plugin data is invalid");
  const forbidden = new Set([
    "files", "conflicts", "dirtyIntents", "outbox", "outboxRefs", "projections", "observedHeads",
    "projectedHeads", "pendingApply", "applyJournals", "recoveryRecords", "localConcurrentRecords",
    "publishedReconciles", "writerFrontiers", "nextSequence", "previousCommitHash", "sparseSeenCommits",
    "vaultEvents", "vaultGenerations", "recoveryCandidates", "operationalStatus", "durableOutbox",
  ].map((key) => key.toLowerCase()));
  const allowedTopLevel = new Set(["schemaVersion", "connection", "repositorySelection", "preferences"]);
  const found = [
    ...Object.keys(value).filter((key) => !allowedTopLevel.has(key)),
    ...findForbiddenKeys(value, forbidden),
  ];
  if (found.length > 0) throw new Error(`plugin data contains operational state: ${found.join(", ")}`);
}

function findForbiddenKeys(value: Record<string, unknown>, forbidden: ReadonlySet<string>, prefix = ""): string[] {
  const found: string[] = [];
  for (const [key, nested] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const normalizedKey = key.replace(/^v1/, "").toLowerCase();
    if (forbidden.has(normalizedKey)) found.push(path);
    if (isRecord(nested)) found.push(...findForbiddenKeys(nested, forbidden, path));
  }
  return found.sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
