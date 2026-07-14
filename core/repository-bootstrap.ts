import { sha256Hex } from "../protocol/hash";
import { canonicalizeProtocolJson } from "../protocol/json";
import { descriptorKey } from "../protocol/keys";
import { verifyRepositoryDescriptor, verifyRepositoryDescriptorAtKey } from "../protocol/validation";
import { readObjectBytes, type ObjectStore } from "./object-store";
import { validateRepositoryDirectories } from "./repository-wizard";

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
  const directories = validateRepositoryDirectories(input.configDir, input.historicalConfigDirs);
  const descriptor = {
    protocol: 1,
    repositoryId: input.repositoryId,
    configDir: directories.configDir,
    historicalConfigDirs: directories.historicalConfigDirs,
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

export async function readRepositoryDescriptorAnchor(
  store: Pick<ObjectStore, "getStream">,
  prefix: string,
  repositoryId: string,
  descriptorHash: string,
): Promise<{ configDir: string; historicalConfigDirs: string[] }> {
  const key = descriptorKey(prefix, repositoryId);
  const bytes = await readObjectBytes(store, key, { maximumBytes: 4 * 1024, expectedHash: descriptorHash });
  const verified = verifyRepositoryDescriptorAtKey(prefix, key, bytes);
  return validateRepositoryDirectories(
    verified.descriptor.configDir as string,
    verified.descriptor.historicalConfigDirs as string[],
  );
}
