import { assertCommitKey } from "../protocol/keys";
import { sha256Hex } from "../protocol/hash";
import { parseAndValidateBoundObject } from "../protocol/validation";
import type { ProtocolCommit } from "../protocol/semantics";
import { compareUtf8 } from "../protocol/utf8";
import { readObjectBytes, type ObjectStore } from "./object-store";

export interface CommitFrontierAnchor {
  key: string;
  writerId: string;
  sequence: string;
  hash: string;
  previousCommitHash: string | null;
}

export type WriterFrontiers = Record<string, CommitFrontierAnchor[]>;

export function advanceWriterFrontiers(
  frontiers: WriterFrontiers,
  commits: readonly CommitFrontierAnchor[],
): WriterFrontiers {
  const byWriter = new Map<string, Map<string, CommitFrontierAnchor>>();
  for (const anchor of [...Object.values(frontiers).flat(), ...commits]) {
    const writer = byWriter.get(anchor.writerId) ?? new Map<string, CommitFrontierAnchor>();
    writer.set(anchor.hash, { ...anchor });
    byWriter.set(anchor.writerId, writer);
  }
  const result: WriterFrontiers = {};
  for (const [writerId, writer] of [...byWriter].sort(([left], [right]) => compareUtf8(left, right))) {
    const referenced = new Set<string>();
    for (const anchor of writer.values()) {
      if (anchor.previousCommitHash === null) {
        if (anchor.sequence !== "00000000000000000001") throw new Error("writer frontier bootstrap sequence is invalid");
        continue;
      }
      const parent = writer.get(anchor.previousCommitHash);
      if (!parent || BigInt(anchor.sequence) !== BigInt(parent.sequence) + 1n) {
        throw new Error("writer frontier is not continuous");
      }
      referenced.add(anchor.previousCommitHash);
    }
    result[writerId] = [...writer.values()]
      .filter((anchor) => !referenced.has(anchor.hash))
      .sort((left, right) => compareUtf8(left.sequence, right.sequence) || compareUtf8(left.hash, right.hash));
  }
  return result;
}

export async function verifyWriterFrontiers(
  store: Pick<ObjectStore, "getStream">,
  repositoryId: string,
  descriptorHash: string,
  frontiers: WriterFrontiers,
): Promise<void> {
  for (const [writerId, anchors] of Object.entries(frontiers).sort(([left], [right]) => compareUtf8(left, right))) {
    for (const anchor of anchors) {
      const bytes = await readObjectBytes(store, anchor.key, { maximumBytes: 256 * 1024, expectedHash: anchor.hash });
      const commit = parseAndValidateBoundObject("commit", bytes, repositoryId, descriptorHash) as unknown as ProtocolCommit;
      assertCommitKey(anchor.key, commit.writerId, commit.sequence, sha256Hex(bytes));
      if (writerId !== anchor.writerId || commit.writerId !== anchor.writerId
        || commit.sequence !== anchor.sequence || commit.previousCommitHash !== anchor.previousCommitHash) {
        throw new Error("persisted Commit frontier anchor does not match its body");
      }
    }
  }
}
