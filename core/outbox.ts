export interface ImmutableOutboxEntry {
  id: string;
  bytes: Uint8Array;
}

export interface QueuedOutboxEntry extends ImmutableOutboxEntry {
  writerId: string;
  sequence: string;
}

export function freezeOutboxBytes(id: string, bytes: Uint8Array): ImmutableOutboxEntry {
  return Object.freeze({ id, bytes: new Uint8Array(bytes) });
}

export function replayOutboxBytes(entry: ImmutableOutboxEntry): Uint8Array {
  return new Uint8Array(entry.bytes);
}

export function nextPublishableOutbox(entries: readonly QueuedOutboxEntry[], writerId: string): QueuedOutboxEntry | undefined {
  return entries.filter((entry) => entry.writerId === writerId).sort((left, right) => left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : 0)[0];
}

export function assertSequenceNotReused(entries: readonly QueuedOutboxEntry[], candidate: QueuedOutboxEntry): void {
  const existing = entries.find((entry) => entry.writerId === candidate.writerId && entry.sequence === candidate.sequence);
  if (existing && (existing.id !== candidate.id || !sameBytes(existing.bytes, candidate.bytes))) throw new Error("writer sequence already belongs to another immutable Outbox entry");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
