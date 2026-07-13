import { repositoryFingerprint, type RepositoryLocator } from "./locator";
import type { CommitFrontierAnchor, WriterFrontiers } from "./commit-frontier";
import type { StateJsonValue } from "./durable-state";

export interface RepositoryDurablePayload {
  repositoryId: string;
  descriptorHash: string;
  repositoryFingerprint: string;
  locator: RepositoryLocator;
  configDir: string;
  historicalConfigDirs: string[];
  writerId: string;
  nextSequence: string;
  previousCommitHash: string | null;
  writerFrontiers: WriterFrontiers;
}

export function repositoryDurablePayload(input: RepositoryDurablePayload): StateJsonValue {
  return JSON.parse(JSON.stringify(input)) as StateJsonValue;
}

export function parseRepositoryDurablePayload(value: StateJsonValue): RepositoryDurablePayload {
  if (!isRecord(value) || !isRecord(value.locator) || !isRecord(value.writerFrontiers)) throw new Error("durable repository payload shape is invalid");
  const repositoryId = requiredString(value.repositoryId, "repositoryId");
  const descriptorHash = requiredHash(value.descriptorHash, "descriptorHash");
  const persistedFingerprint = requiredHash(value.repositoryFingerprint, "repositoryFingerprint");
  const locator: RepositoryLocator = {
    endpoint: requiredString(value.locator.endpoint, "locator.endpoint"),
    region: requiredString(value.locator.region, "locator.region"),
    bucket: requiredString(value.locator.bucket, "locator.bucket"),
    forcePathStyle: requiredBoolean(value.locator.forcePathStyle, "locator.forcePathStyle"),
    normalizedPrefix: requiredString(value.locator.normalizedPrefix, "locator.normalizedPrefix", true),
  };
  if (repositoryFingerprint(locator, repositoryId, descriptorHash) !== persistedFingerprint) throw new Error("durable repository fingerprint is invalid");
  const historicalConfigDirs = requiredStringArray(value.historicalConfigDirs, "historicalConfigDirs");
  const writerId = requiredString(value.writerId, "writerId");
  const nextSequence = requiredString(value.nextSequence, "nextSequence");
  if (!/^[0-9]{20}$/.test(nextSequence) || nextSequence === "00000000000000000000") throw new Error("durable writer sequence is invalid");
  const previousCommitHash = value.previousCommitHash === null ? null : requiredHash(value.previousCommitHash, "previousCommitHash");
  return {
    repositoryId,
    descriptorHash,
    repositoryFingerprint: persistedFingerprint,
    locator,
    configDir: requiredString(value.configDir, "configDir"),
    historicalConfigDirs,
    writerId,
    nextSequence,
    previousCommitHash,
    writerFrontiers: parseFrontiers(value.writerFrontiers),
  };
}

function parseFrontiers(value: Record<string, StateJsonValue>): WriterFrontiers {
  const result: WriterFrontiers = {};
  for (const [writerId, rawAnchors] of Object.entries(value)) {
    if (!Array.isArray(rawAnchors)) throw new Error("durable writer frontier is invalid");
    result[writerId] = rawAnchors.map((raw): CommitFrontierAnchor => {
      if (!isRecord(raw)) throw new Error("durable Commit anchor is invalid");
      const anchorWriterId = requiredString(raw.writerId, "anchor.writerId");
      const sequence = requiredString(raw.sequence, "anchor.sequence");
      if (anchorWriterId !== writerId || !/^[0-9]{20}$/.test(sequence)) throw new Error("durable Commit anchor writer binding is invalid");
      return {
        key: requiredString(raw.key, "anchor.key"),
        writerId: anchorWriterId,
        sequence,
        hash: requiredHash(raw.hash, "anchor.hash"),
        previousCommitHash: raw.previousCommitHash === null ? null : requiredHash(raw.previousCommitHash, "anchor.previousCommitHash"),
      };
    });
  }
  return result;
}

function isRecord(value: StateJsonValue): value is Record<string, StateJsonValue> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: StateJsonValue | undefined, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw new Error(`durable ${name} is invalid`);
  return value;
}

function requiredHash(value: StateJsonValue | undefined, name: string): string {
  const text = requiredString(value, name);
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`durable ${name} is invalid`);
  return text;
}

function requiredBoolean(value: StateJsonValue | undefined, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`durable ${name} is invalid`);
  return value;
}

function requiredStringArray(value: StateJsonValue | undefined, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`durable ${name} is invalid`);
  return [...value] as string[];
}
