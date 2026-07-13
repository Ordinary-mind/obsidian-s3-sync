export interface VaultBlobDependency {
  path: string;
  hash: string;
  size: number;
  heads: string[];
}

export interface AvailableVaultBlob extends VaultBlobDependency {
  bytes: Uint8Array;
}

export interface BlockedVaultBlob {
  path: string;
  heads: string[];
  reason: unknown;
}

export async function resolveVaultBlobDependencies(
  dependencies: readonly VaultBlobDependency[],
  download: (dependency: VaultBlobDependency) => Promise<Uint8Array>,
): Promise<{ available: AvailableVaultBlob[]; blocked: BlockedVaultBlob[] }> {
  const available: AvailableVaultBlob[] = [];
  const blocked: BlockedVaultBlob[] = [];
  for (const dependency of dependencies) {
    try {
      const bytes = await download(dependency);
      if (bytes.byteLength !== dependency.size) throw new Error("Vault Blob dependency size differs");
      available.push({ ...dependency, heads: [...dependency.heads], bytes: new Uint8Array(bytes) });
    } catch (reason) {
      blocked.push({ path: dependency.path, heads: [...dependency.heads], reason });
    }
  }
  return { available, blocked };
}
