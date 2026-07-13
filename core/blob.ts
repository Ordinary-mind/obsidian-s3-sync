import { blobKey } from "../protocol/keys";
import type { StableCapture } from "./stable-capture";
import type { ImmutableObject } from "./immutable-object";

export function buildBlobObject(prefix: string, repositoryId: string, capture: StableCapture): ImmutableObject {
  return {
    key: blobKey(prefix, repositoryId, capture.hash),
    hash: capture.hash,
    bytes: new Uint8Array(capture.bytes),
  };
}
