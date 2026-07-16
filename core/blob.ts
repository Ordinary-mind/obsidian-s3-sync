import { sha256Hex } from "../protocol/hash";
import { blobKey } from "../protocol/keys";
import { protocolLimits } from "../protocol/limits";
import type { StableCapture } from "./stable-capture";
import type { ImmutableObject } from "./immutable-object";

export function assertBlobSize(size: number, platformMaximumBytes: number = protocolLimits.blobBytes): void {
  if (!Number.isSafeInteger(platformMaximumBytes) || platformMaximumBytes < 0) throw new Error("invalid platform Blob limit");
  if (!Number.isSafeInteger(size) || size < 0 || size > protocolLimits.blobBytes) {
    throw new Error(`Blob exceeds the current protocol limit of ${protocolLimits.blobBytes} bytes`);
  }
  if (size > platformMaximumBytes) throw new Error(`Blob exceeds platform limit of ${platformMaximumBytes} bytes`);
}

export function buildBlobObject(
  prefix: string,
  repositoryId: string,
  capture: StableCapture,
  platformMaximumBytes: number = protocolLimits.blobBytes,
): ImmutableObject {
  assertBlobSize(capture.size, platformMaximumBytes);
  if (capture.size !== capture.bytes.byteLength) throw new Error("Blob capture size differs from its bytes");
  if (sha256Hex(capture.bytes) !== capture.hash) throw new Error("Blob capture hash differs from its bytes");
  return {
    key: blobKey(prefix, repositoryId, capture.hash),
    hash: capture.hash,
    bytes: new Uint8Array(capture.bytes),
  };
}
