import { describe, expect, it } from "vitest";

import {
  isUtf8SortedUnique,
  validateCommitEnvelope,
  validateConfigDeleteLineage,
} from "../../protocol/semantics";

const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
const writerId = "123e4567-e89b-42d3-a456-426614174001";
const descriptorHash = "a".repeat(64);

function commit(kind: "change" | "bootstrap" | "conflict-resolution" | "parent-reduction") {
  return {
    protocol: 1 as const,
    repositoryId,
    descriptorHash,
    writerId,
    sequence: "00000000000000000001",
    previousCommitHash: null,
    createdAt: "2026-07-11T00:00:00.000Z",
    channel: "vault" as const,
    kind,
    changeChunkHashes: ["b".repeat(64)],
    clientVersion: "0.1.0",
  };
}

function chunk(parents: string[]) {
  return {
    protocol: 1 as const,
    repositoryId,
    descriptorHash,
    channel: "vault" as const,
    chunkIndex: 0,
    chunkCount: 1,
    mutations: [{ path: "notes/example.md", parents }],
  };
}

function validate(kind: "change" | "bootstrap" | "conflict-resolution" | "parent-reduction", parents: string[]) {
  return validateCommitEnvelope(descriptorHash, commit(kind), [chunk(parents)], ["b".repeat(64)]);
}

function configCommit(kind: "change" | "bootstrap" | "conflict-resolution" | "parent-reduction") {
  return {
    ...commit(kind),
    channel: "config" as const,
  };
}

function configChunk(parents: string[]) {
  return {
    protocol: 1 as const,
    repositoryId,
    descriptorHash,
    channel: "config" as const,
    chunkIndex: 0,
    chunkCount: 1,
    mutations: [{ parents }],
  };
}

describe("v1 protocol semantic envelope", () => {
  it("accepts the four Commit kind parent contracts", () => {
    const parent = "c".repeat(64) + ":0:0";
    const secondParent = "d".repeat(64) + ":0:0";

    expect(validate("bootstrap", [])).toEqual([]);
    expect(validate("change", [parent])).toEqual([]);
    expect(validate("conflict-resolution", [parent])).toEqual([]);
    expect(validate("parent-reduction", [parent, secondParent])).toEqual([]);
  });

  it("accepts the same four Commit kind parent contracts in the Config channel", () => {
    const parent = "c".repeat(64) + ":0:0";
    const secondParent = "d".repeat(64) + ":0:0";

    expect(
      validateCommitEnvelope(descriptorHash, configCommit("bootstrap"), [configChunk([])], ["b".repeat(64)]),
    ).toEqual([]);
    expect(
      validateCommitEnvelope(descriptorHash, configCommit("change"), [configChunk([parent])], ["b".repeat(64)]),
    ).toEqual([]);
    expect(
      validateCommitEnvelope(
        descriptorHash,
        configCommit("conflict-resolution"),
        [configChunk([parent])],
        ["b".repeat(64)],
      ),
    ).toEqual([]);
    expect(
      validateCommitEnvelope(
        descriptorHash,
        configCommit("parent-reduction"),
        [configChunk([parent, secondParent])],
        ["b".repeat(64)],
      ),
    ).toEqual([]);
  });

  it("rejects parent-reduction that is not exactly one mutation with two parents", () => {
    const parent = "c".repeat(64) + ":0:0";
    expect(validate("parent-reduction", [parent])).toContain(
      "parent-reduction-parents",
    );
    expect(
      validateCommitEnvelope(descriptorHash, commit("parent-reduction"), [
        chunk([parent, "d".repeat(64) + ":0:0"]),
        { ...chunk([parent, "d".repeat(64) + ":1:0"]), chunkIndex: 1, chunkCount: 2 },
      ], ["b".repeat(64), "c".repeat(64)]),
    ).toContain("parent-reduction-shape");
  });

  it("rejects descriptor, channel and duplicate-path mismatches before accepting mutations", () => {
    const valid = chunk([]);
    expect(
      validateCommitEnvelope(descriptorHash, { ...commit("bootstrap"), descriptorHash: "e".repeat(64) }, [valid], ["b".repeat(64)]),
    ).toContain("descriptor-hash-mismatch");
    expect(
      validateCommitEnvelope(descriptorHash, commit("bootstrap"), [
        valid,
        { ...valid, chunkIndex: 1, chunkCount: 2 },
      ], ["b".repeat(64), "c".repeat(64)]),
    ).toContain("duplicate-vault-path");
    expect(
      validateCommitEnvelope(descriptorHash, commit("bootstrap"), [
        { ...valid, channel: "config" },
      ], ["b".repeat(64)]),
    ).toContain("chunk-channel-mismatch");
  });

  it("enforces the first Commit previous hash and the exact sequence range", () => {
    const valid = chunk([]);
    expect(
      validateCommitEnvelope(
        descriptorHash,
        { ...commit("bootstrap"), previousCommitHash: "c".repeat(64) },
        [valid],
        ["b".repeat(64)],
      ),
    ).toContain("previous-commit-chain-shape");
    expect(
      validateCommitEnvelope(
        descriptorHash,
        { ...commit("bootstrap"), sequence: "00000000000000000002" },
        [valid],
        ["b".repeat(64)],
      ),
    ).toContain("previous-commit-chain-shape");
    expect(
      validateCommitEnvelope(
        descriptorHash,
        { ...commit("bootstrap"), sequence: "18446744073709551616" },
        [valid],
        ["b".repeat(64)],
      ),
    ).toContain("invalid-sequence");
  });

  it("requires config deletes to be supported by a complete direct parent Tree", () => {
    const parent = "c".repeat(64) + ":0:0";
    const tree = { items: [{ path: "plugins/example/data.json", kind: "delete" as const }] };
    const parentTree = {
      items: [{ path: "plugins/example/data.json", kind: "put" as const }],
    };

    expect(validateConfigDeleteLineage([], tree, new Map())).toEqual(["root-config-delete"]);
    expect(validateConfigDeleteLineage([parent], tree, new Map())).toEqual(["pending-parent-tree"]);
    expect(validateConfigDeleteLineage([parent], tree, new Map([[parent, parentTree]]))).toEqual([]);
    expect(
      validateConfigDeleteLineage([parent], tree, new Map([[parent, { items: [] }]])),
    ).toEqual(["config-delete-not-managed-by-parent"]);
  });

  it("requires UTF-8 canonical order for parents and Vault mutations", () => {
    const high = "d".repeat(64) + ":0:0";
    const low = "c".repeat(64) + ":0:0";
    expect(isUtf8SortedUnique(["a", "é", "😀"])).toBe(true);
    expect(isUtf8SortedUnique(["é", "a"])).toBe(false);
    expect(validate("parent-reduction", [high, low])).toContain("parents-not-canonical");
    expect(
      validateCommitEnvelope(
        descriptorHash,
        commit("bootstrap"),
        [
          {
            ...chunk([]),
            mutations: [
              { path: "notes/z.md", parents: [] },
              { path: "notes/a.md", parents: [] },
            ],
          },
        ],
        ["b".repeat(64)],
      ),
    ).toContain("vault-mutations-not-canonical");
  });
});
