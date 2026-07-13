export type RepositoryObjectKind = "blob" | "config-tree" | "change-chunk" | "commit";
export type RepositoryObjectCategory = "active" | "conflict" | "history" | "orphan";

export interface RepositoryObjectStat {
  key: string;
  kind: RepositoryObjectKind;
  size: number;
  contentHash?: string;
}

export interface RepositorySpaceStatistics {
  categories: Record<RepositoryObjectCategory, { objects: number; bytes: number; byKind: Record<RepositoryObjectKind, number> }>;
  uniqueBytes: number;
  logicalReferencedBytes: number;
  dedupSavedBytes: number;
  orphanKeys: string[];
  estimatedRequestCost?: number;
}

export function calculateRepositorySpaceStatistics(input: {
  objects: readonly RepositoryObjectStat[];
  activeKeys: ReadonlySet<string>;
  conflictKeys: ReadonlySet<string>;
  historicalKeys: ReadonlySet<string>;
  logicalReferencedBytes?: number;
  requestCounts?: { list: number; get: number; put: number };
  pricePerThousandRequests?: { list: number; get: number; put: number };
}): RepositorySpaceStatistics {
  const objects = uniqueObjects(input.objects);
  const categories = {
    active: emptyCategory(), conflict: emptyCategory(), history: emptyCategory(), orphan: emptyCategory(),
  } satisfies RepositorySpaceStatistics["categories"];
  const orphanKeys: string[] = [];
  for (const object of objects) {
    const category: RepositoryObjectCategory = input.activeKeys.has(object.key) ? "active"
      : input.conflictKeys.has(object.key) ? "conflict"
        : input.historicalKeys.has(object.key) ? "history" : "orphan";
    categories[category].objects += 1;
    categories[category].bytes += object.size;
    categories[category].byKind[object.kind] += object.size;
    if (category === "orphan") orphanKeys.push(object.key);
  }
  const uniqueBytes = objects.reduce((total, object) => total + object.size, 0);
  const logicalReferencedBytes = input.logicalReferencedBytes ?? uniqueBytes;
  const estimatedRequestCost = input.requestCounts && input.pricePerThousandRequests
    ? (input.requestCounts.list * input.pricePerThousandRequests.list
      + input.requestCounts.get * input.pricePerThousandRequests.get
      + input.requestCounts.put * input.pricePerThousandRequests.put) / 1000
    : undefined;
  return {
    categories,
    uniqueBytes,
    logicalReferencedBytes,
    dedupSavedBytes: Math.max(0, logicalReferencedBytes - uniqueBytes),
    orphanKeys: orphanKeys.sort(),
    ...(estimatedRequestCost !== undefined ? { estimatedRequestCost } : {}),
  };
}

export function orphanMaintenanceDisposition(): "report-only-no-automatic-delete" {
  return "report-only-no-automatic-delete";
}

function emptyCategory() {
  return { objects: 0, bytes: 0, byKind: { blob: 0, "config-tree": 0, "change-chunk": 0, commit: 0 } };
}

function uniqueObjects(objects: readonly RepositoryObjectStat[]): RepositoryObjectStat[] {
  const byKey = new Map<string, RepositoryObjectStat>();
  for (const object of objects) {
    if (!Number.isSafeInteger(object.size) || object.size < 0) throw new Error("repository object size is invalid");
    const existing = byKey.get(object.key);
    if (existing && (existing.size !== object.size || existing.kind !== object.kind || existing.contentHash !== object.contentHash)) {
      throw new Error("repository object statistics disagree for one immutable key");
    }
    byKey.set(object.key, object);
  }
  return [...byKey.values()];
}
