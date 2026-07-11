export interface DirtyRecord {
  path: string;
  queueId: string;
  generation: number;
  basisHeads: string[];
  localPredecessorVersion?: string;
  awaitingLocalWrite: boolean;
}

export interface FrozenOutboxVersion {
  readonly path: string;
  readonly queueId: string;
  readonly versionId: string;
}

export function captureDirtyIntent(path: string, projectedHeads: readonly string[], generation = 1): DirtyRecord {
  return { path, queueId: path, generation, basisHeads: [...projectedHeads], awaitingLocalWrite: true };
}

export function mergeDirtyEdit(record: DirtyRecord): DirtyRecord {
  return { ...record, generation: record.generation + 1, basisHeads: [...record.basisHeads], awaitingLocalWrite: true };
}

export function nextDirtyGeneration(path: string, generation: number, predecessor: FrozenOutboxVersion): DirtyRecord {
  if (predecessor.path !== path || predecessor.queueId !== path) throw new Error("local predecessor must belong to the same path queue");
  return { path, queueId: path, generation, basisHeads: [], localPredecessorVersion: predecessor.versionId, awaitingLocalWrite: true };
}

export function freezeOutboxVersion(record: DirtyRecord, versionId: string): FrozenOutboxVersion {
  if (record.awaitingLocalWrite) throw new Error("cannot freeze Outbox before editor write is proven");
  return Object.freeze({ path: record.path, queueId: record.queueId, versionId });
}

export function proveEditorWrite(record: DirtyRecord, generation: number): DirtyRecord {
  if (record.generation !== generation) throw new Error("editor generation does not match dirty record");
  return { ...record, awaitingLocalWrite: false };
}
