import { describe, expect, it } from "vitest";

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

    const keyAboveLimit = descriptorKey(`${prefixAtLimit}a`, repositoryId);
    expect(new TextEncoder().encode(keyAboveLimit)).toHaveLength(1025);
    expect(() => assertS3KeyLength(keyAboveLimit)).toThrow(
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
});
