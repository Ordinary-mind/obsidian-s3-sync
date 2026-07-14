import { buildBlobObject } from "./blob";
import { buildVaultChangeEnvelope } from "./commit-builder";
import type { PublishEnvelope } from "./remote-publish";
import type { StableCapture } from "./stable-capture";
import { blobKey } from "../protocol/keys";

export interface VaultPutControlEnvelope {
  blob: { key: string; hash: string; size: number };
  envelope: PublishEnvelope;
}

export function buildVaultPutPublishEnvelope(input: {
  prefix: string;
  repositoryId: string;
  descriptorHash: string;
  writerId: string;
  sequence: string;
  previousCommitHash: string | null;
  createdAt: string;
  clientVersion: string;
  path: string;
  parents: string[];
  capture: StableCapture;
}): PublishEnvelope {
  const blob = buildBlobObject(input.prefix, input.repositoryId, input.capture);
  const control = buildVaultPutControlEnvelope(input);
  return { ...control.envelope, blobs: [blob] };
}

export function buildVaultPutControlEnvelope(input: {
  prefix: string;
  repositoryId: string;
  descriptorHash: string;
  writerId: string;
  sequence: string;
  previousCommitHash: string | null;
  createdAt: string;
  clientVersion: string;
  path: string;
  parents: string[];
  capture: Pick<StableCapture, "hash" | "size">;
}): VaultPutControlEnvelope {
  if (!/^[0-9a-f]{64}$/.test(input.capture.hash)) throw new Error("Vault capture Hash is invalid");
  if (!Number.isSafeInteger(input.capture.size) || input.capture.size < 0) throw new Error("Vault capture size is invalid");
  const blob = {
    key: blobKey(input.prefix, input.repositoryId, input.capture.hash),
    hash: input.capture.hash,
    size: input.capture.size,
  };
  const envelope = buildVaultChangeEnvelope({
    ...input,
    kind: input.previousCommitHash === null ? "bootstrap" : "change",
    mutations: [{ path: input.path, kind: "put", blob: { hash: blob.hash, size: blob.size }, parents: [...input.parents] }],
  });
  return {
    blob,
    envelope: { blobs: [], configTrees: [], chunks: [envelope.chunk], commit: envelope.commit },
  };
}
