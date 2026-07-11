import { createHash } from "node:crypto";

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
