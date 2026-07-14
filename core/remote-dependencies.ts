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

export async function verifyVaultBlobDependencies(
  dependencies: readonly VaultBlobDependency[],
  verify: (dependency: VaultBlobDependency, signal?: AbortSignal) => Promise<void>,
  options: { concurrency?: number; signal?: AbortSignal; yieldEvery?: number; yieldToIdle?: () => Promise<void> } = {},
): Promise<{ available: VaultBlobDependency[]; blocked: BlockedVaultBlob[] }> {
  const concurrency = options.concurrency ?? 4;
  const yieldEvery = options.yieldEvery ?? 128;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("Vault dependency concurrency is invalid");
  if (!Number.isSafeInteger(yieldEvery) || yieldEvery < 1) throw new Error("Vault dependency yield interval is invalid");
  const available: Array<VaultBlobDependency | undefined> = new Array(dependencies.length);
  const blocked: Array<BlockedVaultBlob | undefined> = new Array(dependencies.length);
  let nextIndex = 0;
  let completed = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      if (options.signal?.aborted) throw abortError();
      const index = nextIndex;
      nextIndex += 1;
      if (index >= dependencies.length) return;
      const dependency = dependencies[index];
      try {
        await verify(dependency, options.signal);
        available[index] = { ...dependency, heads: [...dependency.heads] };
      } catch (reason) {
        if (options.signal?.aborted) throw abortError();
        blocked[index] = { path: dependency.path, heads: [...dependency.heads], reason };
      }
      completed += 1;
      if (completed % yieldEvery === 0) await (options.yieldToIdle ?? defaultYieldToIdle)();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, dependencies.length) }, worker));
  return {
    available: available.filter((value): value is VaultBlobDependency => value !== undefined),
    blocked: blocked.filter((value): value is BlockedVaultBlob => value !== undefined),
  };
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

async function defaultYieldToIdle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function abortError(): Error {
  const error = new Error("Vault dependency verification cancelled");
  error.name = "AbortError";
  return error;
}
