import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ProtocolValidationError,
  assertRepositoryBinding,
  parseAndValidateProtocolObject,
  parseAndValidateCommitEnvelope,
  parseAndValidateBoundObject,
  validateProtocolCommitEnvelope,
  verifyRepositoryDescriptor,
} from "../../protocol/validation";
import { canonicalizeProtocolJson } from "../../protocol/json";

const encoder = new TextEncoder();

function vector(path: string) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

describe("protocol receive validation pipeline", () => {
  it("runs bounded parse, schema and isolated-object semantics for fixed vectors", () => {
    const descriptor = vector("../../protocol/vectors/repository-descriptor-basic.json");
    const tree = vector("../../protocol/vectors/config-tree-basic.json");
    const chunk = vector("../../protocol/vectors/vault-change-chunk-put-delete.json");
    const commit = vector("../../protocol/vectors/vault-bootstrap-commit.json");

    expect(parseAndValidateProtocolObject("descriptor", encoder.encode(descriptor.canonicalJson))).toEqual(descriptor.object);
    expect(parseAndValidateProtocolObject("config-tree", encoder.encode(tree.canonicalJson))).toEqual(tree.object);
    expect(parseAndValidateProtocolObject("change-chunk", encoder.encode(chunk.canonicalJson))).toEqual(chunk.object);
    expect(parseAndValidateProtocolObject("commit", encoder.encode(commit.canonicalJson))).toEqual(commit.object);
  });

  it("does not accept schema-valid objects that violate descriptor or ConfigTree semantics", () => {
    const descriptor = vector("../../protocol/vectors/repository-descriptor-basic.json");
    const tree = vector("../../protocol/vectors/config-tree-basic.json");
    const invalidDescriptor = { ...descriptor.object, historicalConfigDirs: ["z", "a"] };
    const invalidTree = { ...tree.object, items: [{ path: "snippets/disabled.css", kind: "put", blobHash: "a".repeat(64), size: 0 }] };

    expect(() => parseAndValidateProtocolObject("descriptor", encoder.encode(canonicalizeProtocolJson(invalidDescriptor)))).toThrow(
      expect.objectContaining({ code: "semantic-invalid" }),
    );
    expect(() => parseAndValidateProtocolObject("config-tree", encoder.encode(canonicalizeProtocolJson(invalidTree)))).toThrow(
      expect.objectContaining({ code: "semantic-invalid" }),
    );
  });

  it("rejects object-local Commit and Change Chunk violations before dependency loading", () => {
    const chunk = vector("../../protocol/vectors/vault-change-chunk-put-delete.json");
    const commit = vector("../../protocol/vectors/vault-bootstrap-commit.json");
    const unsortedChunk = {
      ...chunk.object,
      mutations: [...chunk.object.mutations].reverse(),
    };
    const invalidCommit = { ...commit.object, createdAt: "2026-02-29T00:00:00.000Z" };

    expect(() =>
      parseAndValidateProtocolObject("change-chunk", encoder.encode(canonicalizeProtocolJson(unsortedChunk))),
    ).toThrow(expect.objectContaining({ code: "semantic-invalid" }));
    expect(() =>
      parseAndValidateProtocolObject("commit", encoder.encode(canonicalizeProtocolJson(invalidCommit))),
    ).toThrow(expect.objectContaining({ code: "semantic-invalid" }));
  });

  it("only validates cross-object Commit rules after the complete Chunk envelope is supplied", () => {
    const multi = vector("../../protocol/vectors/vault-bootstrap-multi-chunk.json");
    const chunks = multi.chunks.map((chunk: { object: unknown }) => chunk.object);
    const hashes = multi.chunks.map((chunk: { sha256: string }) => chunk.sha256);

    expect(() =>
      validateProtocolCommitEnvelope(
        "b0856a1538902f1fbd1d71fe7fc56223ac05b14e635ba0951ae1c63f7e2896ec",
        multi.commit.object,
        chunks,
        hashes,
      ),
    ).not.toThrow();
    expect(() =>
      validateProtocolCommitEnvelope(
        "b0856a1538902f1fbd1d71fe7fc56223ac05b14e635ba0951ae1c63f7e2896ec",
        multi.commit.object,
        chunks.slice(0, 1),
        hashes.slice(0, 1),
      ),
    ).toThrow(ProtocolValidationError);
  });

  it("validates a complete Commit envelope directly from untrusted object bytes", () => {
    const multi = vector("../../protocol/vectors/vault-bootstrap-multi-chunk.json");
    const result = parseAndValidateCommitEnvelope(
      "b0856a1538902f1fbd1d71fe7fc56223ac05b14e635ba0951ae1c63f7e2896ec",
      encoder.encode(multi.commit.canonicalJson),
      multi.chunks.map((chunk: { canonicalJson: string }) => encoder.encode(chunk.canonicalJson)),
    );
    expect(result.commit).toEqual(multi.commit.object);
    expect(result.chunkHashes).toEqual(multi.chunks.map((chunk: { sha256: string }) => chunk.sha256));
    expect(result.commitHash).toBe(multi.commit.sha256);
    expect(() =>
      parseAndValidateCommitEnvelope(
        "b0856a1538902f1fbd1d71fe7fc56223ac05b14e635ba0951ae1c63f7e2896ec",
        encoder.encode(multi.commit.canonicalJson),
        [encoder.encode(multi.chunks[0].canonicalJson)],
      ),
    ).toThrow(expect.objectContaining({ code: "commit-envelope-invalid" }));
  });

  it("binds non-descriptor objects to the verified repository descriptor", () => {
    const tree = vector("../../protocol/vectors/config-tree-basic.json");
    const descriptorHash = "b0856a1538902f1fbd1d71fe7fc56223ac05b14e635ba0951ae1c63f7e2896ec";
    expect(() =>
      assertRepositoryBinding(tree.object, "123e4567-e89b-42d3-a456-426614174000", descriptorHash),
    ).not.toThrow();
    expect(() => assertRepositoryBinding(tree.object, "123e4567-e89b-42d3-a456-426614174999", descriptorHash)).toThrow(
      expect.objectContaining({ code: "repository-binding-invalid" }),
    );
    expect(() => assertRepositoryBinding(tree.object, tree.object.repositoryId, "a".repeat(64))).toThrow(
      expect.objectContaining({ code: "repository-binding-invalid" }),
    );
  });

  it("derives descriptorHash only from validated exact descriptor bytes", () => {
    const descriptor = vector("../../protocol/vectors/repository-descriptor-basic.json");
    const verified = verifyRepositoryDescriptor(encoder.encode(descriptor.canonicalJson));
    expect(verified.descriptor).toEqual(descriptor.object);
    expect(verified.descriptorHash).toBe(descriptor.sha256);
  });

  it("does not let a parsed Tree bypass repository binding", () => {
    const tree = vector("../../protocol/vectors/config-tree-basic.json");
    const bytes = encoder.encode(tree.canonicalJson);
    expect(
      parseAndValidateBoundObject(
        "config-tree",
        bytes,
        tree.object.repositoryId,
        tree.object.descriptorHash,
      ),
    ).toEqual(tree.object);
    expect(() => parseAndValidateBoundObject("config-tree", bytes, tree.object.repositoryId, "f".repeat(64))).toThrow(
      expect.objectContaining({ code: "repository-binding-invalid" }),
    );
  });
});
