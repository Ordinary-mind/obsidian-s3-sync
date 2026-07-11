import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  ProtocolKeyError,
  assertCommitKey,
  assertContentAddressedKey,
  assertS3KeyLength,
  blobKey,
  changeChunkKey,
  commitKey,
  configTreeKey,
  descriptorKey,
  normalizeProtocolPrefix,
} from "../../protocol/keys";

const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
const writerId = "123e4567-e89b-42d3-a456-426614174001";
const hash = "ab" + "c".repeat(62);

describe("v1 object keys", () => {
  it("matches the fixed layout without a leading slash for an empty prefix", () => {
    expect(descriptorKey("", repositoryId)).toBe(
      `.obsidian-s3-sync/v1/repositories/${repositoryId}/format.json`,
    );
    expect(blobKey("", repositoryId, hash)).toBe(
      `.obsidian-s3-sync/v1/repositories/${repositoryId}/blobs/sha256/ab/${hash}`,
    );
    expect(configTreeKey("", repositoryId, hash)).toContain(`/config-trees/sha256/ab/${hash}.json`);
    expect(changeChunkKey("", repositoryId, hash)).toContain(`/changes/sha256/ab/${hash}.json`);
    expect(commitKey("", repositoryId, writerId, "00000000000000000001", hash)).toContain(
      `/commits/${writerId}/00000000000000000001-${hash}.json`,
    );
  });

  it("joins a normalized non-empty prefix exactly once", () => {
    expect(descriptorKey("/同步/", repositoryId)).toBe(
      `同步/.obsidian-s3-sync/v1/repositories/${repositoryId}/format.json`,
    );
    expect(descriptorKey("e\u0301", repositoryId)).toBe(
      `é/.obsidian-s3-sync/v1/repositories/${repositoryId}/format.json`,
    );
  });

  it("rejects invalid prefix segments and enforces the UTF-8 S3 key boundary", () => {
    expect(normalizeProtocolPrefix("/同步/")).toBe("同步");
    expect(() => normalizeProtocolPrefix("notes//nested")).toThrow(
      expect.objectContaining({ code: "prefix-invalid" }),
    );
    expect(() => normalizeProtocolPrefix("notes/../nested")).toThrow(ProtocolKeyError);
    expect(() => normalizeProtocolPrefix("notes\\nested")).toThrow(ProtocolKeyError);
    assertS3KeyLength("a".repeat(1024));
    expect(() => assertS3KeyLength("a".repeat(1025))).toThrow(
      expect.objectContaining({ code: "key-too-long" }),
    );
  });

  it("checks the complete generated descriptor Key at the 1,024-byte boundary", () => {
    const suffix = descriptorKey("", repositoryId);
    const prefixAtLimit = "a".repeat(1024 - suffix.length - 1);
    const keyAtLimit = descriptorKey(prefixAtLimit, repositoryId);
    expect(new TextEncoder().encode(keyAtLimit)).toHaveLength(1024);
    expect(() => assertS3KeyLength(keyAtLimit)).not.toThrow();

    expect(() => descriptorKey(`${prefixAtLimit}a`, repositoryId)).toThrow(
      expect.objectContaining({ code: "key-too-long" }),
    );
  });

  it("binds content-addressed and Commit keys to their claimed identity fields", () => {
    const chunk = changeChunkKey("", repositoryId, hash);
    expect(() => assertContentAddressedKey(chunk, hash, ".json")).not.toThrow();
    expect(() => assertContentAddressedKey(chunk, "cd" + "e".repeat(62), ".json")).toThrow(
      expect.objectContaining({ code: "key-body-hash-mismatch" }),
    );
    const commit = commitKey("", repositoryId, writerId, "00000000000000000001", hash);
    expect(() => assertCommitKey(commit, writerId, "00000000000000000001", hash)).not.toThrow();
    expect(() => assertCommitKey(commit, writerId, "00000000000000000002", hash)).toThrow(
      expect.objectContaining({ code: "commit-key-mismatch" }),
    );
  });

  it("rebuilds every fixed object-vector key from its declared identity fields", () => {
    const descriptor = JSON.parse(
      readFileSync(new URL("../../protocol/vectors/repository-descriptor-basic.json", import.meta.url), "utf8"),
    );
    const tree = JSON.parse(
      readFileSync(new URL("../../protocol/vectors/config-tree-basic.json", import.meta.url), "utf8"),
    );
    const change = JSON.parse(
      readFileSync(new URL("../../protocol/vectors/vault-change-chunk-put-delete.json", import.meta.url), "utf8"),
    );
    const commit = JSON.parse(
      readFileSync(new URL("../../protocol/vectors/vault-bootstrap-commit.json", import.meta.url), "utf8"),
    );
    const blob = JSON.parse(
      readFileSync(new URL("../../protocol/vectors/blob-basic.json", import.meta.url), "utf8"),
    );
    const configBootstrap = JSON.parse(
      readFileSync(new URL("../../protocol/vectors/config-bootstrap.json", import.meta.url), "utf8"),
    );

    expect(descriptorKey("", descriptor.object.repositoryId)).toBe(descriptor.key);
    expect(configTreeKey("", tree.object.repositoryId, tree.sha256)).toBe(tree.key);
    expect(changeChunkKey("", change.object.repositoryId, change.sha256)).toBe(change.key);
    expect(
      commitKey("", commit.object.repositoryId, commit.object.writerId, commit.object.sequence, commit.sha256),
    ).toBe(commit.key);
    expect(blobKey("", descriptor.object.repositoryId, blob.sha256)).toBe(blob.key);
    expect(changeChunkKey("", configBootstrap.chunk.object.repositoryId, configBootstrap.chunk.sha256)).toBe(
      configBootstrap.chunk.key,
    );
    expect(
      commitKey(
        "",
        configBootstrap.commit.object.repositoryId,
        configBootstrap.commit.object.writerId,
        configBootstrap.commit.object.sequence,
        configBootstrap.commit.sha256,
      ),
    ).toBe(configBootstrap.commit.key);
  });
});
