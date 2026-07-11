import { describe, expect, it } from "vitest";

import {
  isUtf8SortedUnique,
  validateCommitEnvelope,
  validateConfigDeleteLineage,
  validateConfigTreeExcludedPaths,
  validateConfigTreeProfile,
  validatePluginId,
  validateProtocolPath,
  validateRepositoryDescriptor,
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

  it("rejects duplicate Chunk hashes even if a caller supplied repeated Chunk bytes", () => {
    const repeatedHash = "b".repeat(64);
    expect(
      validateCommitEnvelope(
        descriptorHash,
        { ...commit("bootstrap"), changeChunkHashes: [repeatedHash, repeatedHash] },
        [chunk([]), { ...chunk([]), chunkIndex: 1, chunkCount: 2 }],
        [repeatedHash, repeatedHash],
      ),
    ).toContain("duplicate-chunk-hash");
  });

  it("requires real UTC calendar timestamps and SemVer without build metadata", () => {
    const valid = chunk([]);
    expect(
      validateCommitEnvelope(
        descriptorHash,
        { ...commit("bootstrap"), createdAt: "2026-02-29T00:00:00.000Z" },
        [valid],
        ["b".repeat(64)],
      ),
    ).toContain("invalid-created-at");
    expect(
      validateCommitEnvelope(
        descriptorHash,
        { ...commit("bootstrap"), createdAt: "2024-02-29T23:59:59.999Z" },
        [valid],
        ["b".repeat(64)],
      ),
    ).toEqual([]);
    expect(
      validateCommitEnvelope(
        descriptorHash,
        { ...commit("bootstrap"), clientVersion: "1.0.0+build" },
        [valid],
        ["b".repeat(64)],
      ),
    ).toContain("invalid-client-version");
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
      validateConfigDeleteLineage(
        [parent],
        tree,
        new Map([[parent, { items: [{ path: "plugins/example/data.json", kind: "delete" as const }] }]]),
      ),
    ).toEqual([]);
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

  it("requires ConfigTree profile arrays and items to have one exact management scope", () => {
    const tree = {
      profile: {
        baseFiles: ["app.json"],
        syncThemes: true,
        syncSnippets: false,
        portablePluginIds: ["example-plugin"],
        pluginPackages: ["example-plugin"],
        pluginData: ["example-plugin"],
      },
      enabledCommunityPlugins: ["example-plugin"],
      items: [
        { path: "app.json", kind: "put" as const },
        { path: "plugins/example-plugin/data.json", kind: "put" as const },
        { path: "plugins/example-plugin/main.js", kind: "put" as const },
        { path: "themes/active.css", kind: "put" as const },
      ],
    };

    expect(validateConfigTreeProfile(tree)).toEqual([]);
    expect(
      validateConfigTreeProfile({
        ...tree,
        profile: { ...tree.profile, pluginPackages: ["outside-portable"] },
      }),
    ).toContain("plugin-scope-not-portable");
    expect(
      validateConfigTreeProfile({ ...tree, profile: { ...tree.profile, baseFiles: ["z", "a"] } }),
    ).toContain("config-array-not-canonical");
    expect(
      validateConfigTreeProfile({ ...tree, profile: { ...tree.profile, portablePluginIds: ["A", "a"] } }),
    ).toContain("config-case-alias");
    expect(
      validateConfigTreeProfile({ ...tree, profile: { ...tree.profile, portablePluginIds: ["NUL"] } }),
    ).toContain("plugin-id-invalid");
    expect(
      validateConfigTreeProfile({ ...tree, profile: { ...tree.profile, baseFiles: ["workspace.json"] } }),
    ).toContain("base-file-invalid");
    expect(
      validateConfigTreeProfile({ ...tree, items: [{ path: "", kind: "put" }] }),
    ).toContain("config-item-path-invalid");
    expect(
      validateConfigTreeProfile({
        ...tree,
        items: [
          { path: "themes/active.css", kind: "put" },
          { path: "themes/ACTIVE.css", kind: "put" },
        ],
      }),
    ).toContain("config-put-case-alias");
    expect(
      validateConfigTreeProfile({
        ...tree,
        items: [
          { path: "themes/active", kind: "put" },
          { path: "themes/active/nested.css", kind: "put" },
        ],
      }),
    ).toContain("config-put-path-prefix-conflict");
    expect(
      validateConfigTreeProfile({
        ...tree,
        items: [{ path: "snippets/disabled.css", kind: "put" }],
      }),
    ).toContain("config-item-not-profiled");
  });

  it("rejects non-canonical and unsafe protocol paths before object hashing", () => {
    expect(validateProtocolPath("notes/é.md")).toEqual([]);
    expect(validateProtocolPath("")).toContain("path-invalid-segment");
    expect(validateProtocolPath("notes/e\u0301.md")).toContain("path-not-nfc");
    expect(validateProtocolPath("../notes.md")).toContain("path-invalid-segment");
    expect(validateProtocolPath("notes\\windows.md")).toContain("path-invalid-segment");
    expect(validateProtocolPath("notes/\u0000bad.md")).toContain("path-control-character");
    expect(validateProtocolPath("a".repeat(1025))).toContain("path-too-long");
  });

  it("rejects plugin IDs that cannot be represented safely on all target platforms", () => {
    expect(validatePluginId("example-plugin")).toEqual([]);
    expect(validatePluginId("e\u0301-plugin")).toContain("plugin-id-not-nfc");
    expect(validatePluginId("plugins/example")).toContain("plugin-id-invalid-shape");
    expect(validatePluginId("NUL.json")).toContain("plugin-id-reserved-name");
    expect(validatePluginId("com²")).toContain("plugin-id-reserved-name");
    expect(validatePluginId("trailing.")).toContain("plugin-id-invalid-shape");
    expect(validatePluginId("a".repeat(256))).toContain("plugin-id-too-long");
  });

  it("requires descriptor config roots to be canonical and case-fold distinct", () => {
    expect(
      validateRepositoryDescriptor({ configDir: ".obsidian", historicalConfigDirs: [".obsidian-old"] }),
    ).toEqual([]);
    expect(
      validateRepositoryDescriptor({ configDir: ".obsidian", historicalConfigDirs: ["z", "a"] }),
    ).toContain("descriptor-historical-dirs-not-canonical");
    expect(
      validateRepositoryDescriptor({ configDir: ".obsidian", historicalConfigDirs: [".OBSIDIAN"] }),
    ).toContain("descriptor-historical-dir-case-alias");
    expect(
      validateRepositoryDescriptor({ configDir: "", historicalConfigDirs: [] }),
    ).toContain("descriptor-config-dir-invalid");
    expect(
      validateRepositoryDescriptor({ configDir: ".obsidian", historicalConfigDirs: ["../old"] }),
    ).toContain("descriptor-historical-dir-invalid");
  });

  it("keeps ConfigTree items out of historical and local-only roots", () => {
    expect(
      validateConfigTreeExcludedPaths(".obsidian", [".obsidian-old"], [
        { path: "themes/active.css" },
      ]),
    ).toEqual([]);
    expect(
      validateConfigTreeExcludedPaths(".obsidian", [".obsidian-old"], [
        { path: "themes/active.css" },
      ]),
    ).toEqual([]);
    expect(
      validateConfigTreeExcludedPaths(".obsidian", [".obsidian/themes-old"], [
        { path: "Themes-Old/active.css" },
      ]),
    ).toEqual(["config-item-in-excluded-root"]);
    expect(
      validateConfigTreeExcludedPaths(".obsidian", [], [{ path: "plugins/obsidian-s3-sync/main.js" }]),
    ).toEqual(["config-item-in-excluded-root"]);
    expect(
      validateConfigTreeExcludedPaths(".obsidian", [], [{ path: ".obsidian-s3-sync-local/state" }]),
    ).toEqual(["config-item-in-excluded-root"]);
  });
});
