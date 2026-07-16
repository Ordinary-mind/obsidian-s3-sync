import { validateConfigProfile } from "../core/config-profile";
import { DiagnosticError } from "../core/diagnostics";
import { createRepositoryLocator, repositoryFingerprint } from "../core/locator";
import {
  PLUGIN_DATA_SCHEMA_VERSION,
  assertPluginDataContainsNoOperationalState,
  type CredentialStorage,
  type PersistedRepositorySelection,
  type PluginDataEnvelope,
} from "../core/plugin-data";
import type { ConfigProfile } from "../core/types";
import type { S3SyncSettings } from "./types";

export type PersistedPreferences = Pick<S3SyncSettings,
  "autoSync" | "ignoredPatterns" | "configProfile">;

export type PersistedPluginData = PluginDataEnvelope<PersistedPreferences> & {
  repositorySelection?: PersistedRepositorySelection & { prefix: string };
};

export interface DecodedPluginData {
  settings: S3SyncSettings;
  repositorySelection?: PersistedRepositorySelection;
}

const topLevelKeys = ["connection", "preferences", "repositorySelection", "schemaVersion"] as const;
const connectionKeys = ["bucket", "credentials", "endpoint", "forcePathStyle", "normalizedPrefix", "region"] as const;
const credentialKeys = ["accessKeyId", "kind", "secretAccessKey"] as const;
const preferenceKeys = ["autoSync", "configProfile", "ignoredPatterns"] as const;
const repositoryKeys = [
  "configDir", "descriptorHash", "historicalConfigDirs", "locator", "prefix",
  "repositoryFingerprint", "repositoryId",
] as const;
const locatorKeys = ["bucket", "endpoint", "forcePathStyle", "normalizedPrefix", "region"] as const;
const profileKeys = [
  "baseFiles", "minimumTargetAppVersion", "pluginData", "pluginPackages",
  "portablePluginIds", "syncSnippets", "syncThemes",
] as const;

export function decodePluginData(value: unknown): DecodedPluginData {
  try {
    assertPluginDataContainsNoOperationalState(value);
    const root = record(value, "root");
    exactKeys(root, topLevelKeys, "root", ["repositorySelection"]);
    if (root.schemaVersion !== PLUGIN_DATA_SCHEMA_VERSION) fail("schema-version");

    const connection = record(root.connection, "connection");
    exactKeys(connection, connectionKeys, "connection");
    const credentials = record(connection.credentials, "credentials");
    exactKeys(credentials, credentialKeys, "credentials");
    if (credentials.kind !== "plaintext") fail("credential-kind");
    const endpoint = text(connection.endpoint, "connection.endpoint");
    const region = text(connection.region, "connection.region", true);
    const bucket = text(connection.bucket, "connection.bucket");
    const normalizedPrefix = text(connection.normalizedPrefix, "connection.normalizedPrefix");
    const forcePathStyle = bool(connection.forcePathStyle, "connection.forcePathStyle");
    const accessKeyId = text(credentials.accessKeyId, "credentials.accessKeyId");
    const secretAccessKey = text(credentials.secretAccessKey, "credentials.secretAccessKey");
    const unconfigured = endpoint === "" && bucket === "" && normalizedPrefix === ""
      && accessKeyId === "" && secretAccessKey === "";
    if (root.repositorySelection !== undefined && unconfigured) fail("repository-without-connection");
    if (!unconfigured && (!endpoint || !bucket || !accessKeyId || !secretAccessKey)) fail("partial-connection");
    const locator = unconfigured
      ? { endpoint, region, bucket, forcePathStyle, normalizedPrefix }
      : createRepositoryLocator(
        { endpoint, region, bucket, forcePathStyle, prefix: normalizedPrefix },
        endpoint.startsWith("http://127.0.0.1") || endpoint.startsWith("http://localhost"),
      );
    if (!unconfigured && locator.normalizedPrefix !== normalizedPrefix) fail("connection-prefix-not-normalized");

    const preferences = record(root.preferences, "preferences");
    exactKeys(preferences, preferenceKeys, "preferences");
    const configProfile = configProfileValue(preferences.configProfile);
    const settings: S3SyncSettings = {
      endpoint: locator.endpoint,
      region: locator.region,
      bucket: locator.bucket,
      prefix: locator.normalizedPrefix,
      forcePathStyle: locator.forcePathStyle,
      accessKeyId,
      secretAccessKey,
      autoSync: bool(preferences.autoSync, "preferences.autoSync"),
      ignoredPatterns: text(preferences.ignoredPatterns, "preferences.ignoredPatterns"),
      configProfile,
    };

    return {
      settings,
      ...(root.repositorySelection === undefined
        ? {}
        : { repositorySelection: repositorySelectionValue(root.repositorySelection, locator) }),
    };
  } catch (error) {
    if (error instanceof DiagnosticError && error.code.startsWith("PLUGIN_DATA_")) throw error;
    throw new DiagnosticError("PLUGIN_DATA_INVALID", "local-path", "plugin data failed strict validation", error);
  }
}

export function encodePluginData(
  settings: S3SyncSettings,
  repositorySelection?: PersistedRepositorySelection,
): PersistedPluginData {
  const unconfigured = settings.endpoint === "" && settings.bucket === "" && settings.prefix === ""
    && settings.accessKeyId === "" && settings.secretAccessKey === "";
  if (!unconfigured && (!settings.endpoint || !settings.bucket || !settings.accessKeyId || !settings.secretAccessKey)) {
    fail("partial-connection");
  }
  const locator = unconfigured
    ? {
      endpoint: settings.endpoint,
      region: settings.region,
      bucket: settings.bucket,
      forcePathStyle: settings.forcePathStyle,
      normalizedPrefix: settings.prefix,
    }
    : createRepositoryLocator(
      {
        endpoint: settings.endpoint,
        region: settings.region,
        bucket: settings.bucket,
        forcePathStyle: settings.forcePathStyle,
        prefix: settings.prefix,
      },
      settings.endpoint.startsWith("http://127.0.0.1") || settings.endpoint.startsWith("http://localhost"),
    );
  const credentials: CredentialStorage = {
    kind: "plaintext",
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
  };
  const envelope: PersistedPluginData = {
    schemaVersion: PLUGIN_DATA_SCHEMA_VERSION,
    connection: { ...locator, credentials },
    preferences: {
      autoSync: settings.autoSync,
      ignoredPatterns: settings.ignoredPatterns,
      configProfile: structuredClone(settings.configProfile),
    },
    ...(repositorySelection
      ? { repositorySelection: {
        locator: { ...repositorySelection.locator },
        repositoryId: repositorySelection.repositoryId,
        descriptorHash: repositorySelection.descriptorHash,
        repositoryFingerprint: repositorySelection.repositoryFingerprint,
        configDir: repositorySelection.configDir,
        historicalConfigDirs: [...repositorySelection.historicalConfigDirs],
        prefix: repositorySelection.locator.normalizedPrefix,
      } }
      : {}),
  };
  decodePluginData(envelope);
  return envelope;
}

function repositorySelectionValue(value: unknown, connectionLocator: ReturnType<typeof createRepositoryLocator>): PersistedRepositorySelection {
  const selection = record(value, "repositorySelection");
  exactKeys(selection, repositoryKeys, "repositorySelection");
  const rawLocator = record(selection.locator, "repositorySelection.locator");
  exactKeys(rawLocator, locatorKeys, "repositorySelection.locator");
  const locator = createRepositoryLocator({
    endpoint: text(rawLocator.endpoint, "repositorySelection.locator.endpoint", true),
    region: text(rawLocator.region, "repositorySelection.locator.region", true),
    bucket: text(rawLocator.bucket, "repositorySelection.locator.bucket", true),
    forcePathStyle: bool(rawLocator.forcePathStyle, "repositorySelection.locator.forcePathStyle"),
    prefix: text(rawLocator.normalizedPrefix, "repositorySelection.locator.normalizedPrefix"),
  }, connectionLocator.endpoint.startsWith("http://127.0.0.1") || connectionLocator.endpoint.startsWith("http://localhost"));
  if (locator.endpoint !== connectionLocator.endpoint
    || locator.region !== connectionLocator.region
    || locator.bucket !== connectionLocator.bucket
    || locator.forcePathStyle !== connectionLocator.forcePathStyle
    || locator.normalizedPrefix !== connectionLocator.normalizedPrefix) fail("repository-connection-mismatch");
  if (text(selection.prefix, "repositorySelection.prefix") !== locator.normalizedPrefix) fail("repository-prefix-mismatch");
  const repositoryId = text(selection.repositoryId, "repositorySelection.repositoryId", true);
  const descriptorHash = hash(selection.descriptorHash, "repositorySelection.descriptorHash");
  const persistedFingerprint = hash(selection.repositoryFingerprint, "repositorySelection.repositoryFingerprint");
  if (repositoryFingerprint(locator, repositoryId, descriptorHash) !== persistedFingerprint) fail("repository-fingerprint-mismatch");
  return {
    locator: { ...locator },
    repositoryId,
    descriptorHash,
    repositoryFingerprint: persistedFingerprint,
    configDir: text(selection.configDir, "repositorySelection.configDir", true),
    historicalConfigDirs: stringArray(selection.historicalConfigDirs, "repositorySelection.historicalConfigDirs"),
  };
}

function configProfileValue(value: unknown): ConfigProfile {
  const profile = record(value, "preferences.configProfile");
  exactKeys(profile, profileKeys, "preferences.configProfile");
  const result: ConfigProfile = {
    baseFiles: stringArray(profile.baseFiles, "configProfile.baseFiles"),
    syncThemes: bool(profile.syncThemes, "configProfile.syncThemes"),
    syncSnippets: bool(profile.syncSnippets, "configProfile.syncSnippets"),
    portablePluginIds: stringArray(profile.portablePluginIds, "configProfile.portablePluginIds"),
    pluginPackages: stringArray(profile.pluginPackages, "configProfile.pluginPackages"),
    pluginData: stringArray(profile.pluginData, "configProfile.pluginData"),
    minimumTargetAppVersion: text(profile.minimumTargetAppVersion, "configProfile.minimumTargetAppVersion", true),
  };
  if (validateConfigProfile(result).length > 0) fail("config-profile");
  return result;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value).sort();
  const allowedSet = new Set(allowed);
  if (keys.some((key) => !allowedSet.has(key))) fail(`${name}-unknown-field`);
  const optionalSet = new Set(optional);
  if (allowed.some((key) => !optionalSet.has(key) && !(key in value))) fail(`${name}-missing-field`);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name}-not-object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, required = false): string {
  if (typeof value !== "string" || (required && value.length === 0)) fail(`${name}-not-string`);
  return value as string;
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") fail(`${name}-not-boolean`);
  return value as boolean;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) fail(`${name}-not-string-array`);
  return [...value] as string[];
}

function hash(value: unknown, name: string): string {
  const result = text(value, name, true);
  if (!/^[0-9a-f]{64}$/.test(result)) fail(`${name}-not-hash`);
  return result;
}

function fail(reason: string): never {
  const code = `PLUGIN_DATA_${reason.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
  throw new DiagnosticError(code, "local-path", "plugin data failed strict validation");
}
