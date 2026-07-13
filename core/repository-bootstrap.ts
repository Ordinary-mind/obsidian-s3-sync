import { sha256Hex } from "../protocol/hash";
import { canonicalizeProtocolJson } from "../protocol/json";
import { descriptorKey } from "../protocol/keys";
import { verifyRepositoryDescriptor } from "../protocol/validation";
import type { ObjectStore } from "./object-store";

const encoder = new TextEncoder();

export interface RepositoryBootstrapInput {
  prefix: string;
  repositoryId: string;
  configDir: string;
  historicalConfigDirs: string[];
}

export interface RepositoryBootstrapResult {
  repositoryId: string;
  descriptorHash: string;
  key: string;
}

export async function createRepositoryDescriptor(
  store: ObjectStore,
  input: RepositoryBootstrapInput,
): Promise<RepositoryBootstrapResult> {
  const descriptor = {
    protocol: 1,
    repositoryId: input.repositoryId,
    configDir: input.configDir,
    historicalConfigDirs: [...input.historicalConfigDirs],
    hashAlgorithm: "sha256",
    canonicalJson: "RFC8785",
  };
  const bytes = encoder.encode(canonicalizeProtocolJson(descriptor));
  const verified = verifyRepositoryDescriptor(bytes);
  if (verified.descriptor.repositoryId !== input.repositoryId) {
    throw new Error("repository descriptor identity mismatch");
  }
  const key = descriptorKey(input.prefix, input.repositoryId);
  await store.putImmutable(key, bytes);
  return { repositoryId: input.repositoryId, descriptorHash: sha256Hex(bytes), key };
}
