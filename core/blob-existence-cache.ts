export interface BlobExistenceCacheEntry {
  hash: string;
  size: number;
  verifiedAt: number;
}

export interface BlobExistenceCache {
  get(hash: string): Promise<BlobExistenceCacheEntry | undefined>;
  set(entry: BlobExistenceCacheEntry): Promise<void>;
  delete(hash: string): Promise<void>;
}

export async function verifyBlobWithAdvisoryCache(input: {
  hash: string;
  size: number;
  cache: BlobExistenceCache;
  now: number;
  verifyRemote(): Promise<boolean>;
  publishImmutable(): Promise<void>;
}): Promise<"verified-existing" | "published"> {
  const cached = await input.cache.get(input.hash);
  if (cached && cached.size !== input.size) await input.cache.delete(input.hash);
  // 缓存只改变请求优先级，永远不能替代远端正文/Hash 证明。
  if (await input.verifyRemote()) {
    await input.cache.set({ hash: input.hash, size: input.size, verifiedAt: input.now });
    return "verified-existing";
  }
  await input.publishImmutable();
  if (!(await input.verifyRemote())) throw new Error("Blob remained unverifiable after immutable publication");
  await input.cache.set({ hash: input.hash, size: input.size, verifiedAt: input.now });
  return "published";
}
