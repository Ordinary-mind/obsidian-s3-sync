export interface ConfigDirtyIntent {
  generation: number;
  basisHeads: string[];
  projectedTreeHash: string | null;
}

export function captureConfigDirtyIntent(input: {
  projectedHeads: readonly string[];
  projectedTreeHash: string | null;
  generation: number;
}): ConfigDirtyIntent {
  if (!Number.isSafeInteger(input.generation) || input.generation <= 0) throw new Error("config dirty generation is invalid");
  return { generation: input.generation, basisHeads: [...input.projectedHeads], projectedTreeHash: input.projectedTreeHash };
}

export type ConfigSnapshotMergeDisposition = "empty" | "adopt" | "publish-root" | "conflict";

export function configSnapshotMergeDisposition(localTreeHash: string | undefined, remoteTreeHashes: readonly string[]): ConfigSnapshotMergeDisposition {
  const unique = [...new Set(remoteTreeHashes)];
  if (localTreeHash === undefined && unique.length === 0) return "empty";
  if (unique.length === 0) return "publish-root";
  if (localTreeHash !== undefined && unique.every((hash) => hash === localTreeHash)) return "adopt";
  return "conflict";
}
