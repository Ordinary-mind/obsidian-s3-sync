import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  validateCommitEnvelope,
  validateConfigTreeProfile,
  validateRepositoryDescriptor,
} from "../../protocol/semantics";
import { parseBoundedProtocolJson } from "../../protocol/json";

const schema = JSON.parse(
  readFileSync(new URL("../../protocol/schemas/v1.schema.json", import.meta.url), "utf8"),
);
const descriptorVector = JSON.parse(
  readFileSync(
    new URL("../../protocol/vectors/repository-descriptor-basic.json", import.meta.url),
    "utf8",
  ),
);
const commitVector = JSON.parse(
  readFileSync(
    new URL("../../protocol/vectors/vault-bootstrap-commit.json", import.meta.url),
    "utf8",
  ),
);
const configTreeVector = JSON.parse(
  readFileSync(new URL("../../protocol/vectors/config-tree-basic.json", import.meta.url), "utf8"),
);
const vaultChangeVector = JSON.parse(
  readFileSync(new URL("../../protocol/vectors/vault-change-chunk-put-delete.json", import.meta.url), "utf8"),
);
const multiChunkVector = JSON.parse(
  readFileSync(new URL("../../protocol/vectors/vault-bootstrap-multi-chunk.json", import.meta.url), "utf8"),
);
const configBootstrapVector = JSON.parse(
  readFileSync(new URL("../../protocol/vectors/config-bootstrap.json", import.meta.url), "utf8"),
);
const invalidSchemaVectors = JSON.parse(
  readFileSync(new URL("../../protocol/vectors/invalid-schema-objects.json", import.meta.url), "utf8"),
) as Array<{
  definition: string;
  base: string;
  patch?: Record<string, unknown>;
  delete?: string[];
}>;
const reductionVector = JSON.parse(
  readFileSync(new URL("../../protocol/vectors/config-parent-reduction.json", import.meta.url), "utf8"),
);
const changeAndResolutionVectors = JSON.parse(
  readFileSync(new URL("../../protocol/vectors/vault-change-and-resolution.json", import.meta.url), "utf8"),
);
const configChangeAndResolutionVectors = JSON.parse(
  readFileSync(new URL("../../protocol/vectors/config-change-and-resolution.json", import.meta.url), "utf8"),
);

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema);

function validator(definition: string) {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${definition}`);
  if (!validate) {
    throw new Error(`missing schema definition: ${definition}`);
  }
  return validate;
}

function expectCanonicalVector(
  kind: "descriptor" | "commit" | "change-chunk" | "config-tree",
  canonicalJson: string,
  object: unknown,
) {
  expect(parseBoundedProtocolJson(kind, new TextEncoder().encode(canonicalJson))).toEqual(object);
}

describe("v1 protocol schema", () => {
  it("accepts the fixed RepositoryDescriptor bytes fixture", () => {
    const validate = validator("RepositoryDescriptor");

    expect(validate(descriptorVector.object)).toBe(true);
    expectCanonicalVector("descriptor", descriptorVector.canonicalJson, descriptorVector.object);
    expect(validateRepositoryDescriptor(descriptorVector.object)).toEqual([]);
    expect(
      createHash("sha256").update(descriptorVector.canonicalJson, "utf8").digest("hex"),
    ).toBe(descriptorVector.sha256);
    expect(descriptorVector.key).toBe(
      `.obsidian-s3-sync/v1/repositories/${descriptorVector.object.repositoryId}/format.json`,
    );
  });

  it("accepts the fixed bootstrap Commit bytes fixture and exact object key", () => {
    const validate = validator("Commit");

    expect(validate(commitVector.object)).toBe(true);
    expectCanonicalVector("commit", commitVector.canonicalJson, commitVector.object);
    expect(createHash("sha256").update(commitVector.canonicalJson, "utf8").digest("hex")).toBe(
      commitVector.sha256,
    );
    expect(commitVector.key).toBe(
      `.obsidian-s3-sync/v1/repositories/${commitVector.object.repositoryId}/commits/${commitVector.object.writerId}/${commitVector.object.sequence}-${commitVector.sha256}.json`,
    );
  });

  it("accepts the fixed ConfigTree bytes fixture and exact object key", () => {
    const validate = validator("ConfigTree");

    expect(validate(configTreeVector.object)).toBe(true);
    expectCanonicalVector("config-tree", configTreeVector.canonicalJson, configTreeVector.object);
    expect(validateConfigTreeProfile(configTreeVector.object)).toEqual([]);
    expect(createHash("sha256").update(configTreeVector.canonicalJson, "utf8").digest("hex")).toBe(
      configTreeVector.sha256,
    );
    expect(configTreeVector.key).toBe(
      `.obsidian-s3-sync/v1/repositories/${configTreeVector.object.repositoryId}/config-trees/sha256/${configTreeVector.sha256.slice(0, 2)}/${configTreeVector.sha256}.json`,
    );
  });

  it("accepts fixed Vault put/delete Chunk bytes and its exact object key", () => {
    const validate = validator("ChangeChunk");

    expect(validate(vaultChangeVector.object)).toBe(true);
    expectCanonicalVector("change-chunk", vaultChangeVector.canonicalJson, vaultChangeVector.object);
    expect(createHash("sha256").update(vaultChangeVector.canonicalJson, "utf8").digest("hex")).toBe(
      vaultChangeVector.sha256,
    );
    expect(vaultChangeVector.key).toBe(
      `.obsidian-s3-sync/v1/repositories/${vaultChangeVector.object.repositoryId}/changes/sha256/${vaultChangeVector.sha256.slice(0, 2)}/${vaultChangeVector.sha256}.json`,
    );
  });

  it("accepts the fixed multi-Chunk bootstrap envelope in chunk index order", () => {
    const validateChunk = validator("ChangeChunk");
    const validateCommit = validator("Commit");
    const chunks = multiChunkVector.chunks.map((chunk: { object: unknown }) => chunk.object);
    const hashes = multiChunkVector.chunks.map((chunk: { sha256: string }) => chunk.sha256);

    expect(multiChunkVector.chunks.every((chunk: { object: unknown }) => validateChunk(chunk.object))).toBe(
      true,
    );
    for (const chunk of multiChunkVector.chunks) {
      expectCanonicalVector("change-chunk", chunk.canonicalJson, chunk.object);
    }
    expectCanonicalVector("commit", multiChunkVector.commit.canonicalJson, multiChunkVector.commit.object);
    expect(validateCommit(multiChunkVector.commit.object)).toBe(true);
    expect(
      multiChunkVector.chunks.map((chunk: { canonicalJson: string }) =>
        createHash("sha256").update(chunk.canonicalJson, "utf8").digest("hex"),
      ),
    ).toEqual(hashes);
    expect(
      validateCommitEnvelope(
        descriptorVector.sha256,
        multiChunkVector.commit.object,
        chunks,
        hashes,
      ),
    ).toEqual([]);
  });

  it("accepts the fixed Config snapshot bootstrap envelope", () => {
    const validateChunk = validator("ChangeChunk");
    const validateCommit = validator("Commit");
    const { chunk, commit } = configBootstrapVector;

    expect(validateChunk(chunk.object)).toBe(true);
    expect(validateCommit(commit.object)).toBe(true);
    expectCanonicalVector("change-chunk", chunk.canonicalJson, chunk.object);
    expectCanonicalVector("commit", commit.canonicalJson, commit.object);
    expect(createHash("sha256").update(chunk.canonicalJson, "utf8").digest("hex")).toBe(
      chunk.sha256,
    );
    expect(createHash("sha256").update(commit.canonicalJson, "utf8").digest("hex")).toBe(
      commit.sha256,
    );
    expect(chunk.key).toContain(`/changes/sha256/${chunk.sha256.slice(0, 2)}/${chunk.sha256}.json`);
    expect(commit.key).toContain(`/${commit.object.sequence}-${commit.sha256}.json`);
    expect(
      validateCommitEnvelope(descriptorVector.sha256, commit.object, [chunk.object], [chunk.sha256]),
    ).toEqual([]);
  });

  it("accepts the fixed one-mutation Config parent-reduction envelope", () => {
    const validateChunk = validator("ChangeChunk");
    const validateCommit = validator("Commit");
    const { chunk, commit } = reductionVector;

    expect(validateChunk(chunk.object)).toBe(true);
    expect(validateCommit(commit.object)).toBe(true);
    expectCanonicalVector("change-chunk", chunk.canonicalJson, chunk.object);
    expectCanonicalVector("commit", commit.canonicalJson, commit.object);
    expect(createHash("sha256").update(chunk.canonicalJson, "utf8").digest("hex")).toBe(
      chunk.sha256,
    );
    expect(createHash("sha256").update(commit.canonicalJson, "utf8").digest("hex")).toBe(
      commit.sha256,
    );
    expect(
      validateCommitEnvelope(descriptorVector.sha256, commit.object, [chunk.object], [chunk.sha256]),
    ).toEqual([]);
  });

  it("accepts fixed Vault change and conflict-resolution envelopes", () => {
    const validateChunk = validator("ChangeChunk");
    const validateCommit = validator("Commit");
    for (const vector of changeAndResolutionVectors.vectors) {
      expect(validateChunk(vector.chunk.object)).toBe(true);
      expect(validateCommit(vector.commit.object)).toBe(true);
      expectCanonicalVector("change-chunk", vector.chunk.canonicalJson, vector.chunk.object);
      expectCanonicalVector("commit", vector.commit.canonicalJson, vector.commit.object);
      expect(createHash("sha256").update(vector.chunk.canonicalJson, "utf8").digest("hex")).toBe(
        vector.chunk.sha256,
      );
      expect(createHash("sha256").update(vector.commit.canonicalJson, "utf8").digest("hex")).toBe(
        vector.commit.sha256,
      );
      expect(
        validateCommitEnvelope(
          descriptorVector.sha256,
          vector.commit.object,
          [vector.chunk.object],
          [vector.chunk.sha256],
        ),
      ).toEqual([]);
    }
  });

  it("accepts fixed Config change and conflict-resolution envelopes", () => {
    const validateChunk = validator("ChangeChunk");
    const validateCommit = validator("Commit");
    for (const vector of configChangeAndResolutionVectors.vectors) {
      expect(validateChunk(vector.chunk.object)).toBe(true);
      expect(validateCommit(vector.commit.object)).toBe(true);
      expectCanonicalVector("change-chunk", vector.chunk.canonicalJson, vector.chunk.object);
      expectCanonicalVector("commit", vector.commit.canonicalJson, vector.commit.object);
      expect(
        validateCommitEnvelope(
          descriptorVector.sha256,
          vector.commit.object,
          [vector.chunk.object],
          [vector.chunk.sha256],
        ),
      ).toEqual([]);
    }
  });

  it("rejects unknown descriptor fields", () => {
    const validate = validator("RepositoryDescriptor");

    fc.assert(
      fc.property(
        fc.string().filter(
          (field) =>
            field.length > 0 &&
            ![
              "protocol",
              "repositoryId",
              "configDir",
              "historicalConfigDirs",
              "hashAlgorithm",
              "canonicalJson",
            ].includes(field),
        ),
        (field) => {
          const candidate = { ...descriptorVector.object, [field]: "unexpected" };
          expect(validate(candidate)).toBe(false);
        },
      ),
      { numRuns: 100, seed: 20260711 },
    );
  });

  it("enforces channel-specific mutation branches", () => {
    const validate = validator("ChangeChunk");
    const hash = "a".repeat(64);
    const repositoryId = descriptorVector.object.repositoryId;

    const vaultChunk = {
      protocol: 1,
      repositoryId,
      descriptorHash: hash,
      channel: "vault",
      chunkIndex: 0,
      chunkCount: 1,
      mutations: [
        {
          path: "notes/example.md",
          kind: "put",
          blobHash: hash,
          size: 12,
          parents: [],
        },
      ],
    };
    const configChunk = {
      protocol: 1,
      repositoryId,
      descriptorHash: hash,
      channel: "config",
      chunkIndex: 0,
      chunkCount: 1,
      mutations: [{ key: "portable", kind: "snapshot", treeHash: hash, parents: [] }],
    };

    expect(validate(vaultChunk)).toBe(true);
    expect(validate(configChunk)).toBe(true);
    expect(validate({ ...vaultChunk, channel: "config" })).toBe(false);
    expect(validate({ ...configChunk, channel: "vault" })).toBe(false);
  });

  it("enforces put/delete field combinations", () => {
    const validate = validator("VaultMutation");
    const hash = "b".repeat(64);

    expect(
      validate({ path: "note.md", kind: "put", blobHash: hash, size: 0, parents: [] }),
    ).toBe(true);
    expect(validate({ path: "note.md", kind: "delete", parents: [] })).toBe(true);
    expect(validate({ path: "note.md", kind: "put", parents: [] })).toBe(false);
    expect(
      validate({ path: "note.md", kind: "delete", blobHash: hash, parents: [] }),
    ).toBe(false);
  });

  it("replays versioned invalid schema object vectors", () => {
    const bases: Record<string, Record<string, unknown>> = {
      commit: commitVector.object,
      vaultPut: { path: "note.md", kind: "put", blobHash: "a".repeat(64), size: 0, parents: [] },
      vaultDelete: { path: "note.md", kind: "delete", parents: [] },
      configChunk: configBootstrapVector.chunk.object,
      configTree: configTreeVector.object,
    };
    for (const vector of invalidSchemaVectors) {
      const candidate = { ...bases[vector.base], ...vector.patch };
      for (const field of vector.delete ?? []) delete candidate[field];
      expect(validator(vector.definition)(candidate)).toBe(false);
    }
  });
});
