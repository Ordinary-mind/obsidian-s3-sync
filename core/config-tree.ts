import { sha256Hex } from "../protocol/hash";
import { canonicalizeProtocolJson } from "../protocol/json";
import { configTreeKey } from "../protocol/keys";
import { protocolLimits } from "../protocol/limits";
import { validateConfigBlobDependencies, validateConfigTreeExcludedPaths, type ConfigTreeForProfile } from "../protocol/semantics";
import { parseAndValidateBoundObject } from "../protocol/validation";
import type { ImmutableObject } from "./immutable-object";
import { readObjectBytes, type ObjectStore } from "./object-store";
import { putVerifiedImmutable } from "./remote-publish";

const encoder = new TextEncoder();

export interface ProtocolConfigTree extends ConfigTreeForProfile {
  protocol: 1;
  repositoryId: string;
  descriptorHash: string;
  profile: ConfigTreeForProfile["profile"] & { schema: 1; minimumTargetAppVersion: string };
}

export interface ConfigTreeBinding {
  configDir: string;
  historicalConfigDirs: string[];
}

export function buildConfigTreeObject(
  prefix: string,
  tree: ProtocolConfigTree,
  binding: ConfigTreeBinding,
  resolvedBlobSizes: ReadonlyMap<string, number>,
): ImmutableObject {
  validateTreeBinding(tree, binding);
  const dependencyViolations = validateConfigBlobDependencies(tree, resolvedBlobSizes);
  if (dependencyViolations.length > 0) throw new Error(`ConfigTree Blob dependency invalid: ${dependencyViolations.join(",")}`);
  const bytes = encoder.encode(canonicalizeProtocolJson(tree));
  const verified = parseAndValidateBoundObject("config-tree", bytes, tree.repositoryId, tree.descriptorHash);
  const hash = sha256Hex(bytes);
  if (verified.repositoryId !== tree.repositoryId) throw new Error("ConfigTree repository binding changed during encoding");
  return { key: configTreeKey(prefix, tree.repositoryId, hash), hash, bytes };
}

export async function publishConfigTree(store: ObjectStore, object: ImmutableObject): Promise<void> {
  await putVerifiedImmutable(store, object);
}

export async function downloadConfigTree(
  store: ObjectStore,
  prefix: string,
  repositoryId: string,
  descriptorHash: string,
  treeHash: string,
  binding: ConfigTreeBinding,
): Promise<ProtocolConfigTree> {
  const bytes = await readObjectBytes(store, configTreeKey(prefix, repositoryId, treeHash), {
    maximumBytes: protocolLimits.configTreeBytes,
    expectedHash: treeHash,
  });
  const tree = parseAndValidateBoundObject("config-tree", bytes, repositoryId, descriptorHash) as unknown as ProtocolConfigTree;
  validateTreeBinding(tree, binding);
  return structuredClone(tree);
}

function validateTreeBinding(tree: ProtocolConfigTree, binding: ConfigTreeBinding): void {
  if (validateConfigTreeExcludedPaths(binding.configDir, binding.historicalConfigDirs, tree.items).length > 0) {
    throw new Error("ConfigTree contains an excluded repository path");
  }
}
