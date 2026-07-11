import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  isUtf8SortedUnique,
  validateCommitEnvelope,
  validateChangeChunkObject,
  validateConfigDeleteLineage,
  validateConfigTreeExcludedPaths,
  validateConfigBlobDependencies,
  validateConfigTreeProfile,
  validatePluginId,
  validateProtocolPath,
  validateRepositoryDescriptor,
  validateParentVersionIds,
  validateWriterChain,
  validateVersionGraph,
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

  it("defensively enforces Chunk mutation and parent bounds after Schema validation", () => {
    const parents = Array.from({ length: 1025 }, (_, index) => `${index.toString(16).padStart(64, "0")}:0:0`);
    expect(validateChangeChunkObject(chunk(parents))).toContain("mutation-parents-exceeded");
    expect(
      validateChangeChunkObject({
        ...chunk([]),
        mutations: Array.from({ length: 4097 }, (_, index) => ({ path: `notes/${index}`, parents: [] })),
      }),
    ).toContain("chunk-mutations-exceeded");
  });

  it("rejects Vault puts that have case aliases or file-directory prefix collisions", () => {
    expect(
      validateChangeChunkObject({
        ...chunk([]),
        mutations: [
          { path: "notes/active.md", kind: "put", parents: [], blobHash: "a".repeat(64) },
          { path: "notes/ACTIVE.md", kind: "put", parents: [], blobHash: "b".repeat(64) },
        ],
      }),
    ).toContain("vault-put-case-alias");
    expect(
      validateChangeChunkObject({
        ...chunk([]),
        mutations: [
          { path: "notes/active", kind: "put", parents: [], blobHash: "a".repeat(64) },
          { path: "notes/active/child.md", kind: "put", parents: [], blobHash: "b".repeat(64) },
        ],
      }),
    ).toContain("vault-put-path-prefix-conflict");
  });

  it("defensively enforces the Commit Chunk count boundary", () => {
    const hashes = Array.from({ length: 1025 }, (_, index) => index.toString(16).padStart(64, "0"));
    expect(
      validateCommitEnvelope(
        descriptorHash,
        { ...commit("bootstrap"), changeChunkHashes: hashes },
        [],
        [],
      ),
    ).toContain("commit-chunks-exceeded");
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
        { ...commit("bootstrap"), createdAt: "0000-01-01T00:00:00.000Z" },
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

  it("replays versioned Config delete lineage vectors", () => {
    const vectors = JSON.parse(
      readFileSync(new URL("../../protocol/vectors/config-delete-lineage.json", import.meta.url), "utf8"),
    ) as Array<{
      parents: string[];
      tree: Parameters<typeof validateConfigDeleteLineage>[1];
      resolvedParents: Array<[string, Parameters<typeof validateConfigDeleteLineage>[2] extends ReadonlyMap<string, infer Value> ? Value : never]>;
      violation: string | null;
    }>;
    for (const vector of vectors) {
      const violations = validateConfigDeleteLineage(vector.parents, vector.tree, new Map(vector.resolvedParents));
      if (vector.violation) expect(violations).toContain(vector.violation);
      else expect(violations).toEqual([]);
    }
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
        minimumTargetAppVersion: "1.5.0",
      },
      enabledCommunityPlugins: ["example-plugin"],
      items: [
        { path: "app.json", kind: "put" as const },
        { path: "plugins/example-plugin/data.json", kind: "put" as const },
        { path: "plugins/example-plugin/main.js", kind: "put" as const },
        { path: "plugins/example-plugin/manifest.json", kind: "put" as const },
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
      validateConfigTreeProfile({
        ...tree,
        profile: { ...tree.profile, portablePluginIds: ["Obsidian-S3-Sync"] },
      }),
    ).toContain("sync-plugin-managed");
    expect(
      validateConfigTreeProfile({ ...tree, profile: { ...tree.profile, baseFiles: ["workspace.json"] } }),
    ).toContain("base-file-invalid");
    expect(
      validateConfigTreeProfile({
        ...tree,
        profile: { ...tree.profile, minimumTargetAppVersion: "01.5.0" },
      }),
    ).toContain("minimum-app-version-invalid");
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
        items: [{ path: "plugins/example-plugin/main.js", kind: "put" }],
      }),
    ).toContain("plugin-package-manifest-missing");
    expect(
      validateConfigTreeProfile({
        ...tree,
        items: [
          { path: "themes/z.css", kind: "put" },
          { path: "themes/a.css", kind: "put" },
        ],
      }),
    ).toContain("config-item-path-not-canonical");
    expect(
      validateConfigTreeProfile({
        ...tree,
        items: [
          { path: "themes/a.css", kind: "put" },
          { path: "themes/a.css", kind: "delete" },
        ],
      }),
    ).toContain("config-item-path-duplicate");
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

  it("replays versioned invalid descriptor config-root vectors", () => {
    const vectors = JSON.parse(
      readFileSync(new URL("../../protocol/vectors/invalid-descriptor-semantics.json", import.meta.url), "utf8"),
    ) as Array<{ descriptor: Parameters<typeof validateRepositoryDescriptor>[0]; violation: string }>;
    for (const vector of vectors) {
      expect(validateRepositoryDescriptor(vector.descriptor)).toContain(vector.violation);
    }
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

  it("keeps ConfigTree puts pending until their blobs are known at the declared size", () => {
    const tree = {
      profile: {
        baseFiles: ["app.json"],
        syncThemes: false,
        syncSnippets: false,
        portablePluginIds: [],
        pluginPackages: [],
        pluginData: [],
      },
      enabledCommunityPlugins: [],
      items: [{ path: "app.json", kind: "put" as const, blobHash: "a".repeat(64), size: 4 }],
    };
    expect(validateConfigBlobDependencies(tree, new Map())).toEqual(["config-blob-pending"]);
    expect(validateConfigBlobDependencies(tree, new Map([["a".repeat(64), 3]]))).toEqual([
      "config-blob-size-mismatch",
    ]);
    expect(validateConfigBlobDependencies(tree, new Map([["a".repeat(64), 4]]))).toEqual([]);
  });

  it("defers Version ID index validation until the parent Commit shape is available", () => {
    const hash = "c".repeat(64);
    const known = new Map([[hash, { chunkMutationCounts: [2, 1] }]]);
    expect(validateParentVersionIds([`${hash}:1:0`], known)).toEqual([]);
    expect(validateParentVersionIds([`${hash}:1:1`], known)).toEqual(["version-id-index-out-of-range"]);
    expect(validateParentVersionIds([`${"d".repeat(64)}:0:0`], known)).toEqual([
      "version-id-parent-unresolved",
    ]);
    expect(validateParentVersionIds(["not-a-version"], known)).toEqual(["version-id-malformed"]);
  });

  it("replays versioned Version ID lexical, pending and index-range vectors", () => {
    const vectors = JSON.parse(
      readFileSync(new URL("../../protocol/vectors/version-id-resolution.json", import.meta.url), "utf8"),
    ) as Array<{
      parents: string[];
      shapes: Array<[string, { chunkMutationCounts: number[] }]>;
      violations: string[];
    }>;
    for (const vector of vectors) {
      expect(validateParentVersionIds(vector.parents, new Map(vector.shapes))).toEqual(vector.violations);
    }
  });

  it("detects writer gaps, wrong previous hashes and same-sequence forks without choosing a winner", () => {
    const first = "a".repeat(64);
    const second = "b".repeat(64);
    expect(
      validateWriterChain([
        { sequence: "00000000000000000001", hash: first, previousCommitHash: null },
        { sequence: "00000000000000000002", hash: second, previousCommitHash: first },
      ]),
    ).toEqual([]);
    expect(
      validateWriterChain([{ sequence: "00000000000000000002", hash: second, previousCommitHash: first }]),
    ).toContain("writer-sequence-gap");
    expect(
      validateWriterChain([
        { sequence: "00000000000000000001", hash: first, previousCommitHash: null },
        { sequence: "00000000000000000002", hash: second, previousCommitHash: "c".repeat(64) },
      ]),
    ).toContain("writer-previous-mismatch");
    expect(
      validateWriterChain([
        { sequence: "00000000000000000001", hash: first, previousCommitHash: null },
        { sequence: "00000000000000000001", hash: second, previousCommitHash: null },
      ]),
    ).toContain("writer-sequence-fork");
  });

  it("replays versioned normal, fork and gap writer-chain vectors", () => {
    const vectors = JSON.parse(
      readFileSync(new URL("../../protocol/vectors/writer-chain.json", import.meta.url), "utf8"),
    ) as { normal: Parameters<typeof validateWriterChain>[0]; fork: Parameters<typeof validateWriterChain>[0]; gap: Parameters<typeof validateWriterChain>[0] };
    expect(validateWriterChain(vectors.normal)).toEqual([]);
    expect(validateWriterChain(vectors.fork)).toEqual(["writer-sequence-fork"]);
    expect(validateWriterChain(vectors.gap)).toEqual(["writer-sequence-gap", "writer-previous-mismatch"]);
  });

  it("keeps unresolved parents pending and rejects self, cycles and cross-register edges", () => {
    expect(
      validateVersionGraph([{ versionId: "a", registry: "vault:note", parents: ["missing"] }]),
    ).toEqual(["version-parent-pending"]);
    expect(
      validateVersionGraph([
        { versionId: "a", registry: "vault:note", parents: ["b"] },
        { versionId: "b", registry: "config:portable", parents: [] },
      ]),
    ).toEqual(["version-parent-cross-registry"]);
    expect(
      validateVersionGraph([{ versionId: "a", registry: "vault:note", parents: ["a"] }]),
    ).toEqual(["version-parent-self-reference", "version-parent-cycle"]);
    expect(
      validateVersionGraph([
        { versionId: "a", registry: "vault:note", parents: ["b"] },
        { versionId: "b", registry: "vault:note", parents: ["a"] },
      ]),
    ).toEqual(["version-parent-cycle"]);
  });

  it("replays versioned parent graph pending, cross-register and cycle vectors", () => {
    const vectors = JSON.parse(
      readFileSync(new URL("../../protocol/vectors/version-graph.json", import.meta.url), "utf8"),
    ) as Array<{ nodes: Parameters<typeof validateVersionGraph>[0]; violations: string[] }>;
    for (const vector of vectors) {
      expect(validateVersionGraph(vector.nodes)).toEqual(vector.violations);
    }
  });

  it("replays versioned ConfigTree case-alias, prefix and NFC negative vectors", () => {
    const vectors = JSON.parse(
      readFileSync(new URL("../../protocol/vectors/invalid-config-tree-semantics.json", import.meta.url), "utf8"),
    ) as Array<{ tree: Parameters<typeof validateConfigTreeProfile>[0]; violation: string }>;
    for (const vector of vectors) {
      expect(validateConfigTreeProfile(vector.tree)).toContain(vector.violation);
    }
  });
});
