import { createHash } from "node:crypto";

import { assertCommitKey, assertContentAddressedKey } from "./keys";

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertObjectBodyHash(expectedHash: string, bytes: Uint8Array): void {
  const actualHash = sha256Hex(bytes);
  if (actualHash !== expectedHash) {
    throw new ObjectIntegrityError(expectedHash, actualHash);
  }
}

export class ObjectIntegrityError extends Error {
  constructor(readonly expectedHash: string, readonly actualHash: string) {
    super(`object body SHA-256 mismatch: expected ${expectedHash}, got ${actualHash}`);
    this.name = "ObjectIntegrityError";
  }
}

export function assertContentAddressedObject(key: string, expectedHash: string, bytes: Uint8Array): void {
  assertContentAddressedKey(key, expectedHash, key.endsWith(".json") ? ".json" : "");
  assertObjectBodyHash(expectedHash, bytes);
}

export function assertCommitObject(
  key: string,
  writerId: string,
  sequence: string,
  expectedHash: string,
  bytes: Uint8Array,
): void {
  assertCommitKey(key, writerId, sequence, expectedHash);
  assertObjectBodyHash(expectedHash, bytes);
}
