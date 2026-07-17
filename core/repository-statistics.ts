import { repeatedContinuationTokenError, type ObjectStore, type ObjectStoreRequestOptions } from "./object-store";
import type { RemoteAuditResult } from "./remote-audit";
import { compareUtf8 } from "../protocol/utf8";

export type RepositoryObjectKind = "blob" | "config-tree" | "change-chunk" | "commit";
export type RepositoryObjectCategory = "active" | "conflict" | "history" | "orphan";

export interface RepositoryObjectStat {
  key: string;
  kind: RepositoryObjectKind;
  size: number;
  contentHash?: string;
}

export interface RepositoryRequestCounts {
  list: number;
  get: number;
  put: number;
}

export interface RepositoryRequestPricing {
  currency: string;
  list: number;
  get: number;
  put: number;
}

export interface RepositoryRequestEstimate {
  currency: string;
  amount: number;
  counts: RepositoryRequestCounts;
  pricePerThousand: Omit<RepositoryRequestPricing, "currency">;
}

export interface RepositorySpaceStatistics {
  categories: Record<RepositoryObjectCategory, {
    objects: number;
    bytes: number;
    byKind: Record<RepositoryObjectKind, number>;
  }>;
  uniqueBytes: number;
  reachableBytes: number;
  uniqueReferencedBlobBytes: number;
  logicalReferencedBytes: number;
  dedupSavedBytes: number;
  historyGrowthBytes: number;
  orphanKeys: string[];
  requestEstimate?: RepositoryRequestEstimate;
  estimatedRequestCost?: number;
}

export interface RepositoryObjectReachability {
  activeKeys: Set<string>;
  conflictKeys: Set<string>;
  historicalKeys: Set<string>;
}

export function calculateRepositorySpaceStatistics(input: {
  objects: readonly RepositoryObjectStat[];
  activeKeys: ReadonlySet<string>;
  conflictKeys: ReadonlySet<string>;
  historicalKeys: ReadonlySet<string>;
  logicalReferencedBytes?: number;
  requestCounts?: RepositoryRequestCounts;
  pricePerThousandRequests?: RepositoryRequestPricing | Omit<RepositoryRequestPricing, "currency">;
  requestPriceCurrency?: string;
}): RepositorySpaceStatistics {
  const objects = uniqueObjects(input.objects);
  const categories = {
    active: emptyCategory(), conflict: emptyCategory(), history: emptyCategory(), orphan: emptyCategory(),
  } satisfies RepositorySpaceStatistics["categories"];
  const orphanKeys: string[] = [];
  let reachableBytes = 0;
  let uniqueReferencedBlobBytes = 0;
  for (const object of objects) {
    const category: RepositoryObjectCategory = input.activeKeys.has(object.key) ? "active"
      : input.conflictKeys.has(object.key) ? "conflict"
        : input.historicalKeys.has(object.key) ? "history" : "orphan";
    categories[category].objects += 1;
    categories[category].bytes += object.size;
    categories[category].byKind[object.kind] += object.size;
    if (category === "orphan") orphanKeys.push(object.key);
    else {
      reachableBytes += object.size;
      if (object.kind === "blob") uniqueReferencedBlobBytes += object.size;
    }
  }
  const uniqueBytes = objects.reduce((total, object) => total + object.size, 0);
  const logicalReferencedBytes = input.logicalReferencedBytes ?? uniqueReferencedBlobBytes;
  if (!Number.isSafeInteger(logicalReferencedBytes) || logicalReferencedBytes < 0) {
    throw new Error("logical referenced byte count is invalid");
  }
  const requestEstimate = input.requestCounts && input.pricePerThousandRequests
    ? estimateRepositoryRequestCost(input.requestCounts, {
      currency: "currency" in input.pricePerThousandRequests
        ? input.pricePerThousandRequests.currency
        : input.requestPriceCurrency ?? "USD",
      list: input.pricePerThousandRequests.list,
      get: input.pricePerThousandRequests.get,
      put: input.pricePerThousandRequests.put,
    })
    : undefined;
  return {
    categories,
    uniqueBytes,
    reachableBytes,
    uniqueReferencedBlobBytes,
    logicalReferencedBytes,
    dedupSavedBytes: Math.max(0, logicalReferencedBytes - uniqueReferencedBlobBytes),
    historyGrowthBytes: categories.history.bytes,
    orphanKeys: orphanKeys.sort(),
    ...(requestEstimate ? { requestEstimate, estimatedRequestCost: requestEstimate.amount } : {}),
  };
}

export function repositoryObjectReachability(
  audit: Pick<RemoteAuditResult, "repository" | "reachableObjects" | "versionObjectKeys">,
  repositoryId: string,
): RepositoryObjectReachability {
  const activeKeys = new Set<string>();
  const conflictKeys = new Set<string>();
  for (const state of audit.repository.allRegisters(repositoryId).values()) {
    const target = state.disposition === "resolved" ? activeKeys
      : state.disposition === "concurrent" ? conflictKeys : undefined;
    if (!target) continue;
    for (const head of state.heads) {
      for (const key of audit.versionObjectKeys.get(head) ?? []) target.add(key);
    }
  }
  const historicalKeys = new Set(audit.reachableObjects.map((object) => object.key));
  return { activeKeys, conflictKeys, historicalKeys };
}

export async function listRepositoryProtocolObjects(
  store: Pick<ObjectStore, "list" | "head">,
  prefix: string,
  repositoryId: string,
  options: ObjectStoreRequestOptions = {},
): Promise<RepositoryObjectStat[]> {
  const root = [prefix.replace(/\/$/, ""), `.obsidian-s3-sync/v1/repositories/${repositoryId}/`].filter(Boolean).join("/");
  const objects: RepositoryObjectStat[] = [];
  const tokens = new Set<string>();
  let token: string | undefined;
  do {
    const page = await store.list(root, token, options);
    const listedSizes = new Map((page.objects ?? []).map((object) => [object.key, object.size]));
    for (const key of page.keys) {
      if (!key.startsWith(root)) continue;
      const identity = repositoryObjectIdentity(root, key);
      if (!identity) continue;
      const size = listedSizes.get(key) ?? (await store.head(key, options)).size;
      objects.push({ key, size, ...identity });
    }
    token = page.continuationToken;
    if (token && tokens.has(token)) throw repeatedContinuationTokenError();
    if (token) tokens.add(token);
  } while (token);
  return uniqueObjects(objects).sort((left, right) => compareUtf8(left.key, right.key));
}

export function estimateRepositoryRequestCost(
  counts: RepositoryRequestCounts,
  pricing: RepositoryRequestPricing,
): RepositoryRequestEstimate {
  validateRequestCounts(counts);
  validateRequestPricing(pricing);
  const amount = (counts.list * pricing.list + counts.get * pricing.get + counts.put * pricing.put) / 1000;
  return {
    currency: pricing.currency,
    amount,
    counts: { ...counts },
    pricePerThousand: { list: pricing.list, get: pricing.get, put: pricing.put },
  };
}

export function orphanMaintenanceDisposition(): "report-only-no-automatic-delete" {
  return "report-only-no-automatic-delete";
}

function repositoryObjectIdentity(root: string, key: string): Pick<RepositoryObjectStat, "kind" | "contentHash"> | undefined {
  const relative = key.slice(root.length);
  for (const [pattern, kind] of [
    [/^blobs\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})$/, "blob"],
    [/^config-trees\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})\.json$/, "config-tree"],
    [/^changes\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})\.json$/, "change-chunk"],
  ] as const) {
    const match = pattern.exec(relative);
    if (match && match[1] === match[2].slice(0, 2)) return { kind, contentHash: match[2] };
  }
  const commit = /^commits\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/\d{20}-([0-9a-f]{64})\.json$/.exec(relative);
  return commit ? { kind: "commit", contentHash: commit[1] } : undefined;
}

function emptyCategory() {
  return { objects: 0, bytes: 0, byKind: { blob: 0, "config-tree": 0, "change-chunk": 0, commit: 0 } };
}

function uniqueObjects(objects: readonly RepositoryObjectStat[]): RepositoryObjectStat[] {
  const byKey = new Map<string, RepositoryObjectStat>();
  for (const object of objects) {
    if (!object.key || !Number.isSafeInteger(object.size) || object.size < 0) throw new Error("repository object size is invalid");
    const existing = byKey.get(object.key);
    if (existing && (existing.size !== object.size || existing.kind !== object.kind || existing.contentHash !== object.contentHash)) {
      throw new Error("repository object statistics disagree for one immutable key");
    }
    byKey.set(object.key, { ...object });
  }
  return [...byKey.values()];
}

function validateRequestCounts(counts: RepositoryRequestCounts): void {
  for (const value of Object.values(counts)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("repository request count is invalid");
  }
}

function validateRequestPricing(pricing: RepositoryRequestPricing): void {
  if (!pricing.currency.trim()) throw new Error("request pricing currency is invalid");
  for (const value of [pricing.list, pricing.get, pricing.put]) {
    if (!Number.isFinite(value) || value < 0) throw new Error("repository request price is invalid");
  }
}
