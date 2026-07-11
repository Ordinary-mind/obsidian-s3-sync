import { describe, expect, it } from "vitest";

import { createVersionId, parseVersionId, VersionIdError } from "../../core/version-id";

describe("core Version ID", () => {
  const hash = "a".repeat(64);

  it("creates and parses the frozen hash:chunkIndex:mutationIndex form", () => {
    const versionId = createVersionId(hash, 2, 3);
    expect(versionId).toBe(`${hash}:2:3`);
    expect(parseVersionId(versionId)).toEqual({ commitHash: hash, chunkIndex: 2, mutationIndex: 3 });
  });

  it("rejects malformed hashes, lexical indices and unsafe numeric indices", () => {
    expect(() => createVersionId("A".repeat(64), 0, 0)).toThrow(VersionIdError);
    expect(() => createVersionId(hash, -1, 0)).toThrow(expect.objectContaining({ code: "index-out-of-range" }));
    expect(() => parseVersionId(`${hash}:01:0`)).toThrow(expect.objectContaining({ code: "malformed" }));
    expect(() => parseVersionId(`${hash}:9007199254740992:0`)).toThrow(
      expect.objectContaining({ code: "index-out-of-range" }),
    );
  });
});
