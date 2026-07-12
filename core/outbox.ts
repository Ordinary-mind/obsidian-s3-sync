export interface ImmutableOutboxEntry {
  id: string;
  bytes: Uint8Array;
}

export function freezeOutboxBytes(id: string, bytes: Uint8Array): ImmutableOutboxEntry {
  return Object.freeze({ id, bytes: new Uint8Array(bytes) });
}

export function replayOutboxBytes(entry: ImmutableOutboxEntry): Uint8Array {
  return new Uint8Array(entry.bytes);
}
