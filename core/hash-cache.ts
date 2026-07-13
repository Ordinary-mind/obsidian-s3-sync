import type { StreamHash } from "./streaming-capture";

export interface ImmutableHashCacheEntry extends StreamHash {
  stagedRef: string;
}

export async function resolveImmutableStagedHash(input: {
  mode: "incremental" | "full-audit";
  stagedRef: string;
  cacheEntry?: ImmutableHashCacheEntry;
  compute: () => Promise<StreamHash>;
}): Promise<{ value: StreamHash; cacheEntry: ImmutableHashCacheEntry; cacheHit: boolean }> {
  if (input.mode === "incremental" && input.cacheEntry?.stagedRef === input.stagedRef) {
    return { value: copyHash(input.cacheEntry), cacheEntry: { ...input.cacheEntry }, cacheHit: true };
  }
  const value = await input.compute();
  return {
    value: copyHash(value),
    cacheEntry: { stagedRef: input.stagedRef, ...copyHash(value) },
    cacheHit: false,
  };
}

function copyHash(value: StreamHash): StreamHash {
  return { hash: value.hash, size: value.size };
}
