import { sha256Hex } from "../protocol/hash";
import { canonicalizeProtocolJson } from "../protocol/json";
import { blobKey } from "../protocol/keys";
import { buildVaultChangeEnvelope } from "./commit-builder";
import { buildConfigSnapshotEnvelope } from "./config-commit-builder";
import { buildConfigTreeObject, type ProtocolConfigTree } from "./config-tree";
import {
  buildRepositoryGenerationPlan,
  type RepositoryGenerationPlan,
  type SourceVaultHead,
} from "./maintenance-plan";
import type { RemoteAuditResult } from "./remote-audit";
import { readObjectBytes, type ObjectStore, type ObjectStoreRequestOptions } from "./object-store";
import { putVerifiedImmutable } from "./remote-publish";
import { nextSequence } from "./sequence";
import { createVersionId } from "./version-id";

export type RepositoryGenerationValue =
  | {
    channel: "vault";
    logicalKey: string;
    sourceVersionId: string;
    kind: "put";
    blobHash: string;
    size: number;
  }
  | {
    channel: "vault";
    logicalKey: string;
    sourceVersionId: string;
    kind: "delete";
  }
  | {
    channel: "config";
    logicalKey: string;
    sourceVersionId: string;
    kind: "snapshot";
    tree: ProtocolConfigTree;
  };

export interface FrozenRepositoryGeneration {
  repositoryId: string;
  descriptorHash: string;
  commitKeys: string[];
  commitSetHash: string;
  logicalStateHash: string;
  values: RepositoryGenerationValue[];
  vaultHeads: SourceVaultHead[];
}

export interface RepositoryGenerationTargetBinding {
  repositoryId: string;
  descriptorHash: string;
  configDir: string;
  historicalConfigDirs: string[];
}

export type RepositoryGenerationMigrationResult =
  | {
    status: "blocked";
    plan: RepositoryGenerationPlan;
    blockingVersions: SourceVaultHead[];
    sourceRetained: true;
  }
  | {
    status: "migrated";
    plan: RepositoryGenerationPlan;
    source: FrozenRepositoryGeneration;
    target: FrozenRepositoryGeneration;
    targetBinding: RepositoryGenerationTargetBinding;
    sourceRetained: true;
  };

export interface RepositoryGenerationWriteResult {
  sourceToTargetVersions: ReadonlyMap<string, string>;
  commitKeys: string[];
  copiedBlobKeys: string[];
  nextSequence: string;
  previousCommitHash: string | null;
}

export async function executeRepositoryGenerationMigration(input: {
  sourceRepositoryId: string;
  sourceDescriptorHash: string;
  targetRepositoryId: string;
  sourceConfigDir: string;
  sourceHistoricalConfigDirs: readonly string[];
  targetConfigDir: string;
  participantHistoricalConfigDirs: readonly string[];
  auditSource: () => Promise<RemoteAuditResult>;
  createTargetDescriptor: (input: {
    repositoryId: string;
    configDir: string;
    historicalConfigDirs: string[];
  }) => Promise<{ repositoryId: string; descriptorHash: string }>;
  writeTarget: (input: {
    sourceAudit: RemoteAuditResult;
    source: FrozenRepositoryGeneration;
    target: RepositoryGenerationTargetBinding;
    values: readonly RepositoryGenerationValue[];
  }) => Promise<void>;
  auditTarget: (target: RepositoryGenerationTargetBinding) => Promise<RemoteAuditResult>;
  switchDevices: (target: RepositoryGenerationTargetBinding) => Promise<void>;
}): Promise<RepositoryGenerationMigrationResult> {
  const sourceAudit = await input.auditSource();
  const source = freezeRepositoryGeneration(sourceAudit, input.sourceRepositoryId);
  if (source.descriptorHash !== input.sourceDescriptorHash) {
    throw new Error("source repository generation audit has the wrong descriptor Hash");
  }
  if (sourceAudit.configDir !== input.sourceConfigDir
    || !sameStrings(sourceAudit.historicalConfigDirs, input.sourceHistoricalConfigDirs)) {
    throw new Error("source repository generation directories do not match its audited descriptor");
  }
  const plan = buildRepositoryGenerationPlan({
    sourceRepositoryId: input.sourceRepositoryId,
    targetRepositoryId: input.targetRepositoryId,
    sourceConfigDir: input.sourceConfigDir,
    sourceHistoricalConfigDirs: input.sourceHistoricalConfigDirs,
    targetConfigDir: input.targetConfigDir,
    participantHistoricalConfigDirs: input.participantHistoricalConfigDirs,
    sourceVaultHeads: source.vaultHeads,
  });
  if (plan.blockingVersions.length > 0) {
    return {
      status: "blocked",
      plan,
      blockingVersions: plan.blockingVersions.map((version) => ({ ...version })),
      sourceRetained: true,
    };
  }

  const descriptor = await input.createTargetDescriptor({
    repositoryId: input.targetRepositoryId,
    configDir: plan.targetConfigDir,
    historicalConfigDirs: [...plan.targetHistoricalConfigDirs],
  });
  if (descriptor.repositoryId !== input.targetRepositoryId || !/^[0-9a-f]{64}$/.test(descriptor.descriptorHash)) {
    throw new Error("new repository generation descriptor identity is invalid");
  }
  const targetBinding: RepositoryGenerationTargetBinding = {
    repositoryId: descriptor.repositoryId,
    descriptorHash: descriptor.descriptorHash,
    configDir: plan.targetConfigDir,
    historicalConfigDirs: [...plan.targetHistoricalConfigDirs],
  };
  await input.writeTarget({ sourceAudit, source, target: targetBinding, values: copyGenerationValues(source.values) });

  const sourceAfterWriteAudit = await input.auditSource();
  const sourceAfterWrite = freezeRepositoryGeneration(sourceAfterWriteAudit, input.sourceRepositoryId);
  if (sourceAfterWrite.descriptorHash !== input.sourceDescriptorHash
    || sourceAfterWriteAudit.configDir !== input.sourceConfigDir
    || !sameStrings(sourceAfterWriteAudit.historicalConfigDirs, input.sourceHistoricalConfigDirs)
    || sourceAfterWrite.commitSetHash !== source.commitSetHash
    || sourceAfterWrite.logicalStateHash !== source.logicalStateHash) {
    throw new Error("source repository generation changed after the migration snapshot was frozen");
  }
  const targetAudit = await input.auditTarget(targetBinding);
  const target = freezeRepositoryGeneration(targetAudit, input.targetRepositoryId);
  if (target.descriptorHash !== targetBinding.descriptorHash) {
    throw new Error("target repository generation audit has the wrong descriptor Hash");
  }
  if (targetAudit.configDir !== targetBinding.configDir
    || !sameStrings(targetAudit.historicalConfigDirs, targetBinding.historicalConfigDirs)) {
    throw new Error("target repository generation directories do not match its audited descriptor");
  }
  if (target.logicalStateHash !== source.logicalStateHash) {
    throw new Error("new repository generation logical state Hash does not match the frozen source");
  }

  await input.switchDevices(targetBinding);
  return {
    status: "migrated",
    plan: { ...plan, sourceAuditComplete: true, targetAuditComplete: true },
    source,
    target,
    targetBinding,
    sourceRetained: true,
  };
}

export function freezeRepositoryGeneration(
  audit: RemoteAuditResult,
  repositoryId: string,
): FrozenRepositoryGeneration {
  assertCompleteGenerationAudit(audit);
  if (audit.repositoryId !== repositoryId) throw new Error("repository generation audit identity does not match its repositoryId");
  const values: RepositoryGenerationValue[] = [];
  const vaultHeads: SourceVaultHead[] = [];
  const logicalRegisters: Array<{ channel: "vault" | "config"; logicalKey: string; values: unknown[] }> = [];
  const registers = [...audit.repository.allRegisters(repositoryId).entries()].sort(([left], [right]) => compareUtf8(left, right));
  for (const [registerKey, state] of registers) {
    if (state.disposition === "pending" || state.disposition === "invalid") {
      throw new Error(`repository generation cannot migrate a ${state.disposition} register: ${registerKey}`);
    }
    const [channel, ...logicalKeyParts] = registerKey.split(":");
    const logicalKey = logicalKeyParts.join(":");
    if ((channel !== "vault" && channel !== "config") || !logicalKey) throw new Error("repository generation register key is invalid");
    const logicalValues: unknown[] = [];
    for (const sourceVersionId of state.heads) {
      const version = audit.repository.version(sourceVersionId);
      if (!version || version.repositoryId !== repositoryId || version.channel !== channel || version.logicalKey !== logicalKey) {
        throw new Error("repository generation head is unavailable from the complete audit");
      }
      if (channel === "vault") {
        vaultHeads.push({ path: logicalKey, versionId: sourceVersionId });
        if (version.blob) {
          const value = {
            channel: "vault" as const,
            logicalKey,
            sourceVersionId,
            kind: "put" as const,
            blobHash: version.blob.hash,
            size: version.blob.size,
          };
          values.push(value);
          logicalValues.push({ kind: value.kind, blobHash: value.blobHash, size: value.size });
        } else {
          values.push({ channel: "vault", logicalKey, sourceVersionId, kind: "delete" });
          logicalValues.push({ kind: "delete" });
        }
      } else {
        const tree = copyProtocolConfigTree(version.configTree);
        values.push({ channel: "config", logicalKey, sourceVersionId, kind: "snapshot", tree });
        logicalValues.push(logicalConfigTree(tree));
      }
    }
    logicalRegisters.push({
      channel,
      logicalKey,
      values: logicalValues.sort(compareCanonical),
    });
  }
  values.sort(compareGenerationValues);
  vaultHeads.sort((left, right) => compareUtf8(left.path, right.path) || compareUtf8(left.versionId, right.versionId));
  const commitKeys = [...new Set(audit.commitKeys)].sort(compareUtf8);
  return {
    repositoryId,
    descriptorHash: audit.descriptorHash,
    commitKeys,
    commitSetHash: hashCanonical(commitKeys),
    logicalStateHash: hashCanonical(logicalRegisters),
    values,
    vaultHeads,
  };
}

export async function writeRepositoryGeneration(input: {
  sourceStore: Pick<ObjectStore, "getStream">;
  targetStore: ObjectStore;
  sourcePrefix: string;
  targetPrefix: string;
  sourceAudit: RemoteAuditResult;
  target: RepositoryGenerationTargetBinding;
  writerId: string;
  sequence?: string;
  previousCommitHash?: string | null;
  createdAt: string;
  clientVersion: string;
  options?: ObjectStoreRequestOptions;
}): Promise<RepositoryGenerationWriteResult> {
  const frozen = freezeRepositoryGeneration(input.sourceAudit, input.sourceAudit.repositoryId);
  const sourceToTargetVersions = new Map<string, string>();
  const copiedBlobs = new Map<string, number>();
  const commitKeys: string[] = [];
  let sequence = input.sequence ?? "00000000000000000001";
  let previousCommitHash = input.previousCommitHash ?? null;

  for (const value of frozen.values) {
    let commit: { key: string; hash: string };
    if (value.channel === "vault") {
      if (value.kind === "put") await copyGenerationBlob(input, value.blobHash, value.size, copiedBlobs);
      const envelope = buildVaultChangeEnvelope({
        prefix: input.targetPrefix,
        repositoryId: input.target.repositoryId,
        descriptorHash: input.target.descriptorHash,
        writerId: input.writerId,
        sequence,
        previousCommitHash,
        createdAt: input.createdAt,
        clientVersion: input.clientVersion,
        kind: "bootstrap",
        mutations: [{
          path: value.logicalKey,
          kind: value.kind,
          ...(value.kind === "put" ? { blob: { hash: value.blobHash, size: value.size } } : {}),
          parents: [],
        }],
      });
      await putVerifiedImmutable(input.targetStore, envelope.chunk);
      await putVerifiedImmutable(input.targetStore, envelope.commit);
      commit = envelope.commit;
    } else {
      const targetTree = bindGenerationConfigTree(value.tree, input.target);
      await copyGenerationTreeBlobs(input, targetTree, copiedBlobs);
      let parents: string[] = [];
      if (targetTree.items.some((item) => item.kind === "delete")) {
        const baselineTree = bindGenerationConfigTree(
          generationConfigBaseline(input.sourceAudit, value.sourceVersionId, value.tree),
          input.target,
        );
        await copyGenerationTreeBlobs(input, baselineTree, copiedBlobs);
        const baselineObject = buildConfigTreeObject(
          input.targetPrefix,
          baselineTree,
          input.target,
          configBlobSizes(baselineTree),
        );
        const baseline = buildConfigSnapshotEnvelope({
          prefix: input.targetPrefix,
          repositoryId: input.target.repositoryId,
          descriptorHash: input.target.descriptorHash,
          writerId: input.writerId,
          sequence,
          previousCommitHash,
          createdAt: input.createdAt,
          clientVersion: input.clientVersion,
          kind: "bootstrap",
          treeHash: baselineObject.hash,
          parents: [],
        });
        await putVerifiedImmutable(input.targetStore, baselineObject);
        await putVerifiedImmutable(input.targetStore, baseline.chunk);
        await putVerifiedImmutable(input.targetStore, baseline.commit);
        commitKeys.push(baseline.commit.key);
        parents = [createVersionId(baseline.commit.hash, 0, 0)];
        previousCommitHash = baseline.commit.hash;
        sequence = nextSequence(sequence);
      }
      const tree = buildConfigTreeObject(
        input.targetPrefix,
        targetTree,
        input.target,
        configBlobSizes(targetTree),
      );
      const envelope = buildConfigSnapshotEnvelope({
        prefix: input.targetPrefix,
        repositoryId: input.target.repositoryId,
        descriptorHash: input.target.descriptorHash,
        writerId: input.writerId,
        sequence,
        previousCommitHash,
        createdAt: input.createdAt,
        clientVersion: input.clientVersion,
        kind: parents.length === 0 ? "bootstrap" : "change",
        treeHash: tree.hash,
        parents,
      });
      await putVerifiedImmutable(input.targetStore, tree);
      await putVerifiedImmutable(input.targetStore, envelope.chunk);
      await putVerifiedImmutable(input.targetStore, envelope.commit);
      commit = envelope.commit;
    }
    sourceToTargetVersions.set(value.sourceVersionId, createVersionId(commit.hash, 0, 0));
    commitKeys.push(commit.key);
    previousCommitHash = commit.hash;
    sequence = nextSequence(sequence);
  }

  if (sourceToTargetVersions.size !== frozen.values.length
    || frozen.values.some((value) => !sourceToTargetVersions.has(value.sourceVersionId))) {
    throw new Error("repository generation did not rewrite every frozen semantic value");
  }
  return {
    sourceToTargetVersions,
    commitKeys,
    copiedBlobKeys: [...copiedBlobs.keys()].map((hash) => blobKey(input.targetPrefix, input.target.repositoryId, hash)).sort(compareUtf8),
    nextSequence: sequence,
    previousCommitHash,
  };
}

function bindGenerationConfigTree(
  source: ProtocolConfigTree,
  target: RepositoryGenerationTargetBinding,
): ProtocolConfigTree {
  return {
    ...structuredClone(source),
    repositoryId: target.repositoryId,
    descriptorHash: target.descriptorHash,
  };
}

function generationConfigBaseline(
  audit: RemoteAuditResult,
  sourceVersionId: string,
  sourceTree: ProtocolConfigTree,
): ProtocolConfigTree {
  const items = sourceTree.items.map((item) => {
    if (item.kind !== "delete") return { ...item };
    const prior = findConfigPutInAncestry(audit, sourceVersionId, item.path);
    if (!prior?.blobHash || prior.size === undefined) {
      throw new Error(`repository generation cannot establish ConfigTree delete lineage: ${item.path}`);
    }
    return { path: item.path, kind: "put" as const, blobHash: prior.blobHash, size: prior.size };
  });
  return { ...structuredClone(sourceTree), items };
}

function findConfigPutInAncestry(
  audit: RemoteAuditResult,
  sourceVersionId: string,
  path: string,
): { blobHash?: string; size?: number } | undefined {
  const start = audit.repository.version(sourceVersionId);
  const pending = [...(start?.parents ?? [])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const versionId = pending.shift()!;
    if (visited.has(versionId)) continue;
    visited.add(versionId);
    const version = audit.repository.version(versionId);
    if (!version || version.channel !== "config") continue;
    const tree = copyProtocolConfigTree(version.configTree);
    const item = tree.items.find((candidate) => candidate.path === path);
    if (item?.kind === "put") return item;
    pending.push(...version.parents);
  }
  return undefined;
}

async function copyGenerationTreeBlobs(
  input: Parameters<typeof copyGenerationBlob>[0],
  tree: ProtocolConfigTree,
  copied: Map<string, number>,
): Promise<void> {
  for (const [hash, size] of configBlobSizes(tree)) {
    await copyGenerationBlob(input, hash, size, copied);
  }
}

function configBlobSizes(tree: ProtocolConfigTree): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const item of tree.items) {
    if (item.kind !== "put" || !item.blobHash || item.size === undefined) continue;
    const existing = sizes.get(item.blobHash);
    if (existing !== undefined && existing !== item.size) {
      throw new Error("repository generation ConfigTree reuses a Blob Hash with different sizes");
    }
    sizes.set(item.blobHash, item.size);
  }
  return sizes;
}

function assertCompleteGenerationAudit(audit: RemoteAuditResult): void {
  if (!audit.repositoryId || !/^[0-9a-f]{64}$/.test(audit.descriptorHash)
    || audit.status !== "complete" || !audit.deletionEvidenceAllowed || audit.missingClosure.length > 0
    || audit.verifiedObjects !== audit.totalObjects) {
    throw new Error("repository generation requires a complete reachable-object audit");
  }
}

async function copyGenerationBlob(
  input: {
    sourceStore: Pick<ObjectStore, "getStream">;
    targetStore: ObjectStore;
    sourcePrefix: string;
    targetPrefix: string;
    sourceAudit: RemoteAuditResult;
    target: RepositoryGenerationTargetBinding;
    options?: ObjectStoreRequestOptions;
  },
  hash: string,
  size: number,
  copied: Map<string, number>,
): Promise<void> {
  const knownSize = copied.get(hash);
  if (knownSize !== undefined) {
    if (knownSize !== size) throw new Error("repository generation Blob Hash has inconsistent sizes");
    return;
  }
  const sourceKey = blobKey(input.sourcePrefix, input.sourceAudit.repositoryId, hash);
  const targetKey = blobKey(input.targetPrefix, input.target.repositoryId, hash);
  if (input.targetStore.putImmutableStream) {
    await input.targetStore.putImmutableStream(
      targetKey,
      async () => input.sourceStore.getStream(sourceKey, input.options),
      { hash, size },
      input.options,
    );
  } else {
    const bytes = await readObjectBytes(input.sourceStore, sourceKey, {
      ...input.options,
      maximumBytes: size,
      expectedHash: hash,
    });
    if (bytes.byteLength !== size) throw new Error("repository generation source Blob size changed");
    await input.targetStore.putImmutable(targetKey, bytes, input.options);
  }
  copied.set(hash, size);
}

function copyProtocolConfigTree(value: unknown): ProtocolConfigTree {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("repository generation ConfigTree is unavailable from the complete audit");
  }
  const tree = structuredClone(value) as ProtocolConfigTree;
  if (tree.protocol !== 1 || typeof tree.repositoryId !== "string" || typeof tree.descriptorHash !== "string"
    || !tree.profile || !Array.isArray(tree.enabledCommunityPlugins) || !Array.isArray(tree.items)) {
    throw new Error("repository generation ConfigTree is invalid");
  }
  return tree;
}

function logicalConfigTree(tree: ProtocolConfigTree): unknown {
  return {
    profile: structuredClone(tree.profile),
    enabledCommunityPlugins: [...tree.enabledCommunityPlugins],
    items: tree.items.map((item) => ({ ...item })),
  };
}

function copyGenerationValues(values: readonly RepositoryGenerationValue[]): RepositoryGenerationValue[] {
  return values.map((value) => value.channel === "config"
    ? { ...value, tree: structuredClone(value.tree) }
    : { ...value });
}

function compareGenerationValues(left: RepositoryGenerationValue, right: RepositoryGenerationValue): number {
  return compareUtf8(left.channel, right.channel)
    || compareUtf8(left.logicalKey, right.logicalKey)
    || compareUtf8(left.sourceVersionId, right.sourceVersionId);
}

function compareCanonical(left: unknown, right: unknown): number {
  return compareUtf8(canonicalizeProtocolJson(left), canonicalizeProtocolJson(right));
}

function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalizeProtocolJson(value));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}
