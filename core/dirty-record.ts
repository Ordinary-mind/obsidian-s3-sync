export interface DirtyRecord {
  path: string;
  generation: number;
  basisHeads: string[];
  localPredecessorVersion?: string;
  awaitingLocalWrite: boolean;
}

export function captureDirtyIntent(path: string, projectedHeads: readonly string[], generation = 1): DirtyRecord {
  return { path, generation, basisHeads: [...projectedHeads], awaitingLocalWrite: true };
}

export function mergeDirtyEdit(record: DirtyRecord): DirtyRecord {
  return { ...record, generation: record.generation + 1, basisHeads: [...record.basisHeads], awaitingLocalWrite: true };
}

export function nextDirtyGeneration(path: string, generation: number, localPredecessorVersion: string): DirtyRecord {
  return { path, generation, basisHeads: [], localPredecessorVersion, awaitingLocalWrite: true };
}

export function proveEditorWrite(record: DirtyRecord, generation: number): DirtyRecord {
  if (record.generation !== generation) throw new Error("editor generation does not match dirty record");
  return { ...record, awaitingLocalWrite: false };
}
