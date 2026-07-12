export interface ObjectStore {
  list(prefix: string, continuationToken?: string): Promise<{ keys: string[]; continuationToken?: string }>;
  get(key: string): Promise<Uint8Array>;
  head(key: string): Promise<{ size: number }>;
  putImmutable(key: string, bytes: Uint8Array): Promise<void>;
}

export interface ObjectStoreFailure {
  kind: "not-found" | "temporary" | "auth" | "integrity";
  operation: "list" | "get" | "head" | "put";
}

export function canWriteAfterProbe(atomicCreateVerified: boolean): boolean {
  return atomicCreateVerified;
}
