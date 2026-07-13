import { repositoryFingerprint, type RepositoryLocator } from "./locator";
import { vaultPathCaseFoldKey } from "./path";

export interface PersistedRepositoryBinding {
  locator: RepositoryLocator;
  repositoryId: string;
  descriptorHash: string;
  repositoryFingerprint: string;
  configDir: string;
  historicalConfigDirs: string[];
}

export function createPersistedRepositoryBinding(
  locator: RepositoryLocator,
  repositoryId: string,
  descriptorHash: string,
  configDir: string,
  historicalConfigDirs: readonly string[],
): PersistedRepositoryBinding {
  return {
    locator: { ...locator },
    repositoryId,
    descriptorHash,
    repositoryFingerprint: repositoryFingerprint(locator, repositoryId, descriptorHash),
    configDir,
    historicalConfigDirs: [...historicalConfigDirs],
  };
}

export function assertPersistedRepositoryBinding(
  binding: PersistedRepositoryBinding,
  currentLocator: RepositoryLocator,
  actualConfigDir: string,
  localHistoricalConfigDirs: readonly string[],
): void {
  if (!binding.locator || typeof binding.repositoryFingerprint !== "string"
    || typeof binding.configDir !== "string" || !Array.isArray(binding.historicalConfigDirs)) {
    throw new Error("persisted repository binding is incomplete; select the repository again");
  }
  const expectedFingerprint = repositoryFingerprint(binding.locator, binding.repositoryId, binding.descriptorHash);
  const currentFingerprint = repositoryFingerprint(currentLocator, binding.repositoryId, binding.descriptorHash);
  if (binding.repositoryFingerprint !== expectedFingerprint || currentFingerprint !== expectedFingerprint) {
    throw new Error("RepositoryLocator changed; select the repository again");
  }
  if (vaultPathCaseFoldKey(binding.configDir) !== vaultPathCaseFoldKey(actualConfigDir)) {
    throw new Error("vault.configDir changed; create a new repository generation before publishing or applying");
  }
  const descriptorHistory = new Set(binding.historicalConfigDirs.map(vaultPathCaseFoldKey));
  if (localHistoricalConfigDirs.some((path) => !descriptorHistory.has(vaultPathCaseFoldKey(path)))) {
    throw new Error("local historical configDir set is not bound by RepositoryDescriptor");
  }
}

export function assertDescriptorDirectoryBinding(
  binding: Pick<PersistedRepositoryBinding, "configDir" | "historicalConfigDirs">,
  descriptor: { configDir: string; historicalConfigDirs: readonly string[] },
): void {
  if (binding.configDir !== descriptor.configDir
    || binding.historicalConfigDirs.length !== descriptor.historicalConfigDirs.length
    || binding.historicalConfigDirs.some((path, index) => path !== descriptor.historicalConfigDirs[index])) {
    throw new Error("persisted RepositoryDescriptor directory binding changed");
  }
}
