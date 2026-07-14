import { buildBlobObject } from "./blob";
import { buildConfigSnapshotEnvelope } from "./config-commit-builder";
import { buildConfigTreeObject, type ConfigTreeBinding, type ProtocolConfigTree } from "./config-tree";
import type { PublishEnvelope } from "./remote-publish";
import type { CommitKind } from "./types";
import { protocolLimits } from "../protocol/limits";

export function buildConfigSnapshotPublishEnvelope(input: {
  prefix: string;
  repositoryId: string;
  descriptorHash: string;
  writerId: string;
  sequence: string;
  previousCommitHash: string | null;
  createdAt: string;
  clientVersion: string;
  parents: readonly string[];
  tree: ProtocolConfigTree;
  bytesByPath: ReadonlyMap<string, Uint8Array>;
  binding: ConfigTreeBinding;
  kind?: CommitKind;
}): { envelope: PublishEnvelope; treeHash: string; versionId: string; parents: string[] } {
  if (input.tree.repositoryId !== input.repositoryId || input.tree.descriptorHash !== input.descriptorHash) {
    throw new Error("ConfigTree belongs to another repository binding");
  }

  const blobsByHash = new Map<string, ReturnType<typeof buildBlobObject>>();
  const sizes = new Map<string, number>();
  for (const item of input.tree.items) {
    if (item.kind !== "put") continue;
    if (!item.blobHash || item.size === undefined) throw new Error(`ConfigTree put has no Blob reference: ${item.path}`);
    const bytes = input.bytesByPath.get(item.path);
    if (!bytes) throw new Error(`verified ConfigTree bytes are unavailable: ${item.path}`);
    const blob = buildBlobObject(input.prefix, input.repositoryId, { hash: item.blobHash, size: item.size, bytes });
    const existing = blobsByHash.get(blob.hash);
    if (existing && !sameBytes(existing.bytes, blob.bytes)) throw new Error("ConfigTree reuses a Blob hash with different bytes");
    blobsByHash.set(blob.hash, blob);
    sizes.set(blob.hash, item.size);
  }

  const treeObject = buildConfigTreeObject(input.prefix, input.tree, input.binding, sizes);
  const parents = [...new Set(input.parents)].sort(compareUtf8);
  if (parents.length > protocolLimits.mutationParents) throw new Error("ConfigTree publication requires parent reduction");
  const built = buildConfigSnapshotEnvelope({
    prefix: input.prefix,
    repositoryId: input.repositoryId,
    descriptorHash: input.descriptorHash,
    writerId: input.writerId,
    sequence: input.sequence,
    previousCommitHash: input.previousCommitHash,
    createdAt: input.createdAt,
    clientVersion: input.clientVersion,
    kind: input.kind ?? configCommitKind(parents),
    treeHash: treeObject.hash,
    parents,
  });
  return {
    envelope: {
      blobs: [...blobsByHash.values()],
      configTrees: [treeObject],
      chunks: [built.chunk],
      commit: built.commit,
    },
    treeHash: treeObject.hash,
    versionId: `${built.commit.hash}:0:0`,
    parents,
  };
}

function configCommitKind(parents: readonly string[]): CommitKind {
  if (parents.length === 0) return "bootstrap";
  return parents.length === 1 ? "change" : "conflict-resolution";
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return a.length - b.length;
}
