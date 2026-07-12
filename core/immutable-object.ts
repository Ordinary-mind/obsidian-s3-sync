export interface ImmutableObject {
  key: string;
  hash: string;
  bytes: Uint8Array;
}

export function verifyImmutableObject(existing: ImmutableObject | undefined, candidate: ImmutableObject): "create" | "already-present" {
  if (!existing) return "create";
  if (existing.key !== candidate.key || existing.hash !== candidate.hash || !sameBytes(existing.bytes, candidate.bytes)) throw new Error("immutable object collision with different bytes");
  return "already-present";
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean { return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]); }
