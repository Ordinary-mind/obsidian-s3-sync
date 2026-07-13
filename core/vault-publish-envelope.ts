import { buildBlobObject } from "./blob";
import { buildVaultChangeEnvelope } from "./commit-builder";
import type { PublishEnvelope } from "./remote-publish";
import type { StableCapture } from "./stable-capture";

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
  const envelope = buildVaultChangeEnvelope({
    ...input,
    kind: input.previousCommitHash === null ? "bootstrap" : "change",
    mutations: [{ path: input.path, kind: "put", blob: { hash: blob.hash, size: blob.bytes.byteLength }, parents: [...input.parents] }],
  });
  return { blobs: [blob], configTrees: [], chunks: [envelope.chunk], commit: envelope.commit };
}
