import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

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

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema);

function validator(definition: string) {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${definition}`);
  if (!validate) {
    throw new Error(`missing schema definition: ${definition}`);
  }
  return validate;
}

describe("v1 protocol schema", () => {
  it("accepts the fixed RepositoryDescriptor bytes fixture", () => {
    const validate = validator("RepositoryDescriptor");

    expect(validate(descriptorVector.object)).toBe(true);
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
    expect(createHash("sha256").update(configTreeVector.canonicalJson, "utf8").digest("hex")).toBe(
      configTreeVector.sha256,
    );
    expect(configTreeVector.key).toBe(
      `.obsidian-s3-sync/v1/repositories/${configTreeVector.object.repositoryId}/config-trees/sha256/${configTreeVector.sha256.slice(0, 2)}/${configTreeVector.sha256}.json`,
    );
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
});
