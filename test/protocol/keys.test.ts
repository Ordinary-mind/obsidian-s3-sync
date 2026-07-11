import { describe, expect, it } from "vitest";

import { blobKey, changeChunkKey, commitKey, configTreeKey, descriptorKey } from "../../protocol/keys";

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
  });
});
