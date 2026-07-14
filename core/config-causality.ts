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

export function configPublicationParents(input: {
  projectLocal: boolean;
  resolveObservedConflict: boolean;
  projectedHeads: readonly string[];
  projectedTreeHash: string | null;
  observedHeads: readonly string[];
  dirtyIntent?: ConfigDirtyIntent;
}): string[] {
  if (input.projectLocal && input.projectedTreeHash === null) return [];
  if (!input.projectLocal || input.resolveObservedConflict) return sortedUnique(input.observedHeads);
  return sortedUnique(input.dirtyIntent?.basisHeads ?? input.projectedHeads);
}

export type ConfigSnapshotMergeDisposition = "empty" | "adopt" | "publish-root" | "conflict";

export function configSnapshotMergeDisposition(localTreeHash: string | undefined, remoteTreeHashes: readonly string[]): ConfigSnapshotMergeDisposition {
  const unique = [...new Set(remoteTreeHashes)];
  if (localTreeHash === undefined && unique.length === 0) return "empty";
  if (unique.length === 0) return "publish-root";
  if (localTreeHash !== undefined && unique.every((hash) => hash === localTreeHash)) return "adopt";
  return "conflict";
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareUtf8);
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}
