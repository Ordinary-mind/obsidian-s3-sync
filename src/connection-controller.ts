import { createRepositoryLocator, RepositoryConfigurationError, type RepositoryLocator } from "../core/locator";
import { assertPersistedRepositoryBinding } from "../core/repository-binding";
import { DiagnosticError } from "../core/diagnostics";
import { validateRepositoryDirectories } from "../core/repository-directories";
import { vaultPathCaseFoldKey } from "../core/path";
import { withConnectionFlowStage, withConnectionInitializationStep, type ConnectionFlowStage } from "../core/safe-error";
import type { S3SyncData, S3SyncSettings } from "./types";
import type { V1RepositoryService } from "./v1-service";
import { resolveEffectivePrefix } from "./connection-prefix";

export type ConnectionSettingsInput = Pick<S3SyncSettings,
  "endpoint" | "region" | "bucket" | "prefix" | "forcePathStyle" | "accessKeyId" | "secretAccessKey">;

export type DiscoveredRepository = Awaited<ReturnType<V1RepositoryService["discover"]>>[number];
export type ConnectionRepositoryService = Pick<V1RepositoryService,
  "discover" | "createRepository" | "assertDescriptorBinding" | "verifyFrontierAnchor" | "probeWritableConnection">;

export interface ConnectionControllerHost {
  readonly configDir: string;
  readonly vaultName: string;
  getSettings(): S3SyncSettings;
  setSettings(settings: S3SyncSettings): void;
  getData(): S3SyncData;
  setData(data: S3SyncData): void;
  createService(settings: S3SyncSettings, prefix: string): ConnectionRepositoryService;
  stopAndFlush(): Promise<void>;
  persistRepositoryState(): Promise<void>;
  clearRepositoryState(): void;
  createUnboundData(): S3SyncData;
  activateRepository(locator: RepositoryLocator, repository: DiscoveredRepository): Promise<void>;
  savePluginData(): Promise<void>;
  markRepositoryVerified(): void;
}

export class ConnectionController {
  constructor(private readonly host: ConnectionControllerHost) {}

  async testAndApply(input: ConnectionSettingsInput): Promise<string> {
    let stage: ConnectionFlowStage = "configuration";
    try {
      const currentSettings = this.host.getSettings();
      const candidateSettings = { ...currentSettings, ...input };
      requireCredentials(candidateSettings);
      const existing = this.host.getData().v1;
      if (existing) {
        assertPersistedRepositoryBinding(
          existing,
          existing.locator,
          existing.configDir,
          existing.historicalConfigDirs,
        );
      }

      const requestedPrefix = existing && input.prefix === currentSettings.prefix
        ? existing.locator.normalizedPrefix
        : resolveEffectivePrefix(candidateSettings.prefix, this.host.vaultName);
      const candidateLocator = createRepositoryLocator({
        endpoint: candidateSettings.endpoint,
        region: candidateSettings.region,
        bucket: candidateSettings.bucket,
        forcePathStyle: candidateSettings.forcePathStyle,
        prefix: requestedPrefix,
      }, isLoopbackHttp(candidateSettings.endpoint));
      const normalizedSettings = { ...candidateSettings, prefix: candidateLocator.normalizedPrefix };

      let service: ConnectionRepositoryService;
      try {
        service = this.host.createService(normalizedSettings, candidateLocator.normalizedPrefix);
      } catch (error) {
        throw withConnectionInitializationStep("s3-client", error);
      }
      stage = "repository-discovery";
      const repositories = await service.discover();
      const sameRepositoryScope = !!existing
        && candidateLocator.bucket === existing.locator.bucket
        && candidateLocator.normalizedPrefix === existing.locator.normalizedPrefix;
      let repository: DiscoveredRepository | undefined;

      if (existing && sameRepositoryScope) {
        stage = "repository-verification";
        try {
          assertPersistedRepositoryBinding(
            existing,
            existing.locator,
            this.host.configDir,
            existing.historicalConfigDirs,
          );
        } catch (cause) {
          throw new DiagnosticError(
            "CONNECTION_LOCAL_DIRECTORY_BINDING_CHANGED",
            "repository-identity",
            "the Vault config directory no longer matches the selected repository; use a new Prefix to create a new repository",
            cause,
          );
        }
        if (repositories.length !== 1) throw ambiguousRepositoryScope(repositories.length);
        const current = repositories.find((candidate) => candidate.repositoryId === existing.repositoryId
          && candidate.descriptorHash === existing.descriptorHash);
        if (!current) {
          throw new DiagnosticError(
            "CONNECTION_REPOSITORY_NOT_FOUND",
            "repository-identity",
            "the selected repository was not discovered through the candidate connection",
          );
        }
        await service.assertDescriptorBinding(existing.repositoryId, existing.descriptorHash, existing);
        for (const anchor of Object.values(existing.writerFrontiers).flat()) {
          await service.verifyFrontierAnchor(existing.repositoryId, existing.descriptorHash, anchor);
        }
        repository = current;
      } else if (repositories.length > 1) {
        throw ambiguousRepositoryScope(repositories.length);
      } else {
        repository = repositories[0];
      }

      const requiredDirectories = validateRepositoryDirectories(
        this.host.configDir,
        existing
          ? [existing.configDir, ...existing.historicalConfigDirs]
            .filter((path) => vaultPathCaseFoldKey(path) !== vaultPathCaseFoldKey(this.host.configDir))
          : [],
      );
      if (repository) assertRepositoryDirectories(repository, requiredDirectories);

      stage = "write-probe";
      await service.probeWritableConnection(crypto.randomUUID());
      let created = false;
      if (!repository) {
        stage = "repository-create";
        const result = await service.createRepository(
          crypto.randomUUID(),
          requiredDirectories.configDir,
          requiredDirectories.historicalConfigDirs,
        );
        repository = {
          ...result,
          ...requiredDirectories,
        };
        created = true;
      }
      stage = "settings-apply";
      return await this.applyCandidate({
        currentSettings,
        currentData: this.host.getData(),
        candidateSettings: normalizedSettings,
        candidateLocator,
        repository,
        created,
        existing,
        sameRepositoryScope,
      });
    } catch (error) {
      throw withConnectionFlowStage(stage, error);
    }
  }

  private async applyCandidate(input: {
    currentSettings: S3SyncSettings;
    currentData: S3SyncData;
    candidateSettings: S3SyncSettings;
    candidateLocator: RepositoryLocator;
    repository: DiscoveredRepository;
    created: boolean;
    existing: S3SyncData["v1"];
    sameRepositoryScope: boolean;
  }): Promise<string> {
    const previousSettings = structuredClone(input.currentSettings);
    const previousData = structuredClone(input.currentData);
    try {
      if (input.existing && input.sameRepositoryScope) {
        const routeChanged = input.candidateLocator.endpoint !== input.existing.locator.endpoint
          || input.candidateLocator.region !== input.existing.locator.region
          || input.candidateLocator.forcePathStyle !== input.existing.locator.forcePathStyle;
        if (routeChanged) await this.host.stopAndFlush();
        this.host.setSettings(input.candidateSettings);
        this.host.setData({
          ...input.currentData,
          v1: { ...input.existing, locator: input.candidateLocator },
        });
        this.host.markRepositoryVerified();
        await this.host.savePluginData();
        return "连接成功并已验证当前仓库。";
      }

      if (input.existing) {
        await this.host.stopAndFlush();
        await this.host.persistRepositoryState();
        this.host.clearRepositoryState();
        this.host.setData(this.host.createUnboundData());
        this.host.setSettings({ ...input.candidateSettings, autoSync: false });
      } else {
        this.host.setSettings(input.candidateSettings);
      }

      try {
        await this.host.activateRepository(input.candidateLocator, input.repository);
      } catch (error) {
        throw withConnectionFlowStage("repository-bind", error);
      }
      if (input.created) return "连接成功；已自动创建并接入仓库。";
      return input.existing
        ? "连接成功；旧仓库状态已保留，并已接入当前仓库。"
        : "连接成功并已接入当前仓库。";
    } catch (error) {
      this.host.setSettings(previousSettings);
      this.host.setData(previousData);
      this.host.clearRepositoryState();
      try {
        await this.host.savePluginData();
      } catch (rollbackError) {
        throw new DiagnosticError(
          "CONNECTION_APPLY_ROLLBACK_FAILED",
          "local-path",
          "connection apply failed and the previous local settings could not be persisted again",
          rollbackError,
        );
      }
      throw error;
    }
  }
}

function ambiguousRepositoryScope(count: number): DiagnosticError {
  return new DiagnosticError(
    "CONNECTION_REPOSITORY_SCOPE_AMBIGUOUS",
    "repository-identity",
    `the configured Bucket and Prefix contain ${count} repository descriptors; exactly one is required`,
  );
}

function assertRepositoryDirectories(
  repository: Pick<DiscoveredRepository, "configDir" | "historicalConfigDirs">,
  required: { configDir: string; historicalConfigDirs: readonly string[] },
): void {
  const remote = validateRepositoryDirectories(repository.configDir, repository.historicalConfigDirs);
  const remoteHistory = new Set(remote.historicalConfigDirs.map(vaultPathCaseFoldKey));
  const currentMatches = vaultPathCaseFoldKey(remote.configDir) === vaultPathCaseFoldKey(required.configDir);
  const historyCovered = required.historicalConfigDirs.every((path) => remoteHistory.has(vaultPathCaseFoldKey(path)));
  if (currentMatches && historyCovered) return;
  throw new DiagnosticError(
    "CONNECTION_REMOTE_DIRECTORY_BINDING_MISMATCH",
    "repository-identity",
    "the discovered repository is bound to a different config directory or does not exclude required historical config directories; use another Prefix",
  );
}

function requireCredentials(settings: S3SyncSettings): void {
  if (settings.accessKeyId.length === 0) throw new RepositoryConfigurationError("access-key-id", "required");
  if (settings.secretAccessKey.length === 0) throw new RepositoryConfigurationError("secret-access-key", "required");
}

function isLoopbackHttp(endpoint: string): boolean {
  return endpoint.startsWith("http://127.0.0.1") || endpoint.startsWith("http://localhost");
}
