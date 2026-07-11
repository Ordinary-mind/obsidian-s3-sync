import Ajv2020 from "ajv/dist/2020.js";

import schema from "./schemas/v1.schema.json";
import { BoundedProtocolObject, parseBoundedProtocolJson } from "./json";
import {
  ProtocolChunk,
  ProtocolCommit,
  ProtocolViolation,
  validateCommitEnvelope,
  validateConfigTreeProfile,
  validateRepositoryDescriptor,
} from "./semantics";

type SchemaDefinition = "RepositoryDescriptor" | "ConfigTree" | "ChangeChunk" | "Commit";

export class ProtocolValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProtocolValidationError";
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema);

export function parseAndValidateProtocolObject(kind: BoundedProtocolObject, bytes: Uint8Array): Record<string, unknown> {
  const object = parseBoundedProtocolJson(kind, bytes);
  const definition = definitionFor(kind);
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${definition}`);
  if (!validate) throw new Error(`missing protocol schema definition: ${definition}`);
  if (!validate(object)) {
    throw new ProtocolValidationError("schema-invalid", ajv.errorsText(validate.errors));
  }
  const semanticViolations = singleObjectViolations(kind, object);
  if (semanticViolations.length > 0) {
    throw new ProtocolValidationError("semantic-invalid", semanticViolations.join(","));
  }
  return object;
}

export function validateProtocolCommitEnvelope(
  descriptorHash: string,
  commit: ProtocolCommit,
  chunks: ProtocolChunk[],
  chunkHashes: string[],
): void {
  const violations = validateCommitEnvelope(descriptorHash, commit, chunks, chunkHashes);
  if (violations.length > 0) {
    throw new ProtocolValidationError("commit-envelope-invalid", violations.join(","));
  }
}

function definitionFor(kind: BoundedProtocolObject): SchemaDefinition {
  const definitions: Record<BoundedProtocolObject, SchemaDefinition> = {
    descriptor: "RepositoryDescriptor",
    "config-tree": "ConfigTree",
    "change-chunk": "ChangeChunk",
    commit: "Commit",
  };
  return definitions[kind];
}

function singleObjectViolations(kind: BoundedProtocolObject, object: Record<string, unknown>): string[] {
  if (kind === "descriptor") return validateRepositoryDescriptor(object as never);
  if (kind === "config-tree") return validateConfigTreeProfile(object as never);
  return [];
}
