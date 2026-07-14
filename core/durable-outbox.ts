import type { ImmutableObject } from "./immutable-object";
import type { StagedContent } from "./content-staging";
import type { PublishEnvelope } from "./remote-publish";
import { parseVersionId } from "./version-id";

export type DurableOutboxState =
  | "queued"
  | "publishing"
  | "published"
  | "retryable-error"
  | "integrity-error"
  | "recovery-required";

export type DurableOutboxObjectKind = "blob" | "config-tree" | "change-chunk" | "commit";

export interface DurableOutboxObject {
  kind: DurableOutboxObjectKind;
  key: string;
  hash: string;
  size: number;
  contentRef: string;
}

export interface DurableOutboxMutation {
  registerKey: string;
  versionId: string;
  kind: "put" | "delete" | "config-snapshot";
  parents: string[];
  valueHash: string | null;
  stagedContentRef?: string;
  capturedDirtyGeneration?: number;
  capturedEventGeneration?: number;
}

export interface DurableOutboxEntry {
  id: string;
  repositoryFingerprint: string;
  writerId: string;
  sequence: string;
  previousCommitHash: string | null;
  commitHash: string;
  captureGeneration: number;
  state: DurableOutboxState;
  writerDisposition: "active" | "forked-draining";
  objects: DurableOutboxObject[];
  mutations: DurableOutboxMutation[];
}

export interface DurablePublishedReconcile {
  outboxId: string;
  registerKey: string;
  generation: number;
  publishedVersionId: string;
  publishedValueHash: string | null;
  stagedContentRef?: string;
  state: "pending" | "adopted" | "next-generation";
}

export interface OutboxContentStager {
  stage(chunks: AsyncIterable<Uint8Array>, estimatedBytes?: number): Promise<StagedContent>;
}

export interface DurableOutboxReplaySource {
  verify(contentRef: string, expected: { hash: string; size: number }): Promise<void>;
  read(contentRef: string): Promise<AsyncIterable<Uint8Array>>;
}

export interface DurableOutboxReplayTarget {
  readonly repositoryFingerprint: string;
  putImmutable(object: Pick<DurableOutboxObject, "kind" | "key" | "hash" | "size">, body: AsyncIterable<Uint8Array>): Promise<void>;
  verifyRemote(object: Pick<DurableOutboxObject, "kind" | "key" | "hash" | "size">): Promise<void>;
}

export async function freezeDurableOutbox(input: {
  envelope: PublishEnvelope;
  repositoryFingerprint: string;
  writerId: string;
  sequence: string;
  previousCommitHash: string | null;
  captureGeneration: number;
  mutations: readonly DurableOutboxMutation[];
}, stager: OutboxContentStager): Promise<DurableOutboxEntry> {
  assertWriterAndSequence(input.writerId, input.sequence);
  if (!/^[0-9a-f]{64}$/.test(input.repositoryFingerprint)) throw new Error("Outbox repository fingerprint is invalid");
  if (!Number.isSafeInteger(input.captureGeneration) || input.captureGeneration < 0) throw new Error("Outbox capture generation is invalid");
  if (input.envelope.commit.hash.length !== 64) throw new Error("Outbox Commit hash is invalid");
  const objects: DurableOutboxObject[] = [];
  for (const [kind, values] of orderedEnvelopeObjects(input.envelope)) {
    for (const object of values) objects.push(await stageObject(stager, kind, object));
  }
  const commitObject = objects.at(-1);
  if (!commitObject || commitObject.kind !== "commit" || commitObject.hash !== input.envelope.commit.hash) {
    throw new Error("Outbox Commit was not frozen last");
  }
  const mutations = input.mutations.map(copyMutation);
  assertUniqueMutations(mutations);
  const entry = Object.freeze({
    id: input.envelope.commit.hash,
    repositoryFingerprint: input.repositoryFingerprint,
    writerId: input.writerId,
    sequence: input.sequence,
    previousCommitHash: input.previousCommitHash,
    commitHash: input.envelope.commit.hash,
    captureGeneration: input.captureGeneration,
    state: "queued" as const,
    writerDisposition: "active" as const,
    objects: Object.freeze(objects.map((object) => Object.freeze({ ...object }))) as unknown as DurableOutboxObject[],
    mutations: Object.freeze(mutations.map((mutation) => Object.freeze({ ...mutation, parents: Object.freeze([...mutation.parents]) }))) as unknown as DurableOutboxMutation[],
  });
  assertDurableOutboxQueue([entry]);
  return entry;
}

export function nextDurableOutbox(entries: readonly DurableOutboxEntry[], writerId: string): DurableOutboxEntry | undefined {
  assertDurableOutboxQueue(entries);
  const writerEntries = entries.filter((entry) => entry.writerId === writerId && !isTerminal(entry.state));
  const publishing = writerEntries.filter((entry) => entry.state === "publishing");
  if (publishing.length > 1) throw new Error("a writer has more than one publishing Outbox");
  if (publishing.length === 1) return publishing[0];
  return [...writerEntries]
    .filter((entry) => entry.state === "queued" || entry.state === "retryable-error")
    .sort(compareSequence)[0];
}

export function transitionDurableOutbox(
  entry: DurableOutboxEntry,
  next: DurableOutboxState,
): DurableOutboxEntry {
  const allowed: Record<DurableOutboxState, DurableOutboxState[]> = {
    queued: ["publishing", "recovery-required"],
    publishing: ["published", "retryable-error", "integrity-error", "recovery-required"],
    published: [],
    "retryable-error": ["publishing", "recovery-required"],
    "integrity-error": ["recovery-required"],
    "recovery-required": [],
  };
  if (!allowed[entry.state].includes(next)) throw new Error(`invalid durable Outbox transition: ${entry.state} -> ${next}`);
  return freezeEntry({ ...entry, state: next });
}

export function markWriterForked(entries: readonly DurableOutboxEntry[], writerId: string): DurableOutboxEntry[] {
  return entries.map((entry) => entry.writerId === writerId && !isTerminal(entry.state)
    ? freezeEntry({ ...entry, writerDisposition: "forked-draining" })
    : entry);
}

export function forkedWriterDisposition(
  entries: readonly DurableOutboxEntry[],
  writerId: string,
  verifiedOutboxIds: ReadonlySet<string>,
): "drain" | "rotate" | "recovery-required" {
  const pending = entries.filter((entry) => entry.writerId === writerId && entry.state !== "published");
  if (pending.some((entry) => !verifiedOutboxIds.has(entry.id))) return "recovery-required";
  return pending.length === 0 ? "rotate" : "drain";
}

export function createPublishedReconciles(entry: DurableOutboxEntry): DurablePublishedReconcile[] {
  if (entry.state !== "published") throw new Error("Outbox Commit is not verified published");
  return entry.mutations.map((mutation) => ({
    outboxId: entry.id,
    registerKey: mutation.registerKey,
    generation: entry.captureGeneration,
    publishedVersionId: mutation.versionId,
    publishedValueHash: mutation.valueHash,
    ...(mutation.stagedContentRef ? { stagedContentRef: mutation.stagedContentRef } : {}),
    state: "pending",
  }));
}

export function reconcilePublishedMutation(
  reconcile: DurablePublishedReconcile,
  observation: { kind: "put"; hash: string } | { kind: "delete" } | { kind: "unknown" },
  hasNewDirtyIntent: boolean,
): DurablePublishedReconcile {
  if (reconcile.state !== "pending") return reconcile;
  if (observation.kind === "unknown") return reconcile;
  const observedHash = observation.kind === "put" ? observation.hash : null;
  const state = !hasNewDirtyIntent && observedHash === reconcile.publishedValueHash ? "adopted" : "next-generation";
  return { ...reconcile, state };
}

export function publishedReconcileBlocksAutomaticApply(
  reconciles: readonly DurablePublishedReconcile[],
  registerKey: string,
): boolean {
  return reconciles.some((reconcile) => reconcile.registerKey === registerKey && reconcile.state === "pending");
}

export async function replayFrozenDurableOutbox(
  entry: DurableOutboxEntry,
  source: DurableOutboxReplaySource,
  target: DurableOutboxReplayTarget,
): Promise<void> {
  if (entry.state !== "publishing") throw new Error("durable Outbox must be publishing before replay");
  if (entry.repositoryFingerprint !== target.repositoryFingerprint) throw new Error("durable Outbox belongs to another repository binding");
  assertDurableOutboxQueue([entry]);
  for (const object of entry.objects) {
    await source.verify(object.contentRef, { hash: object.hash, size: object.size });
    await target.putImmutable(object, await source.read(object.contentRef));
    await target.verifyRemote(object);
  }
}

export function assertDurableOutboxQueue(entries: readonly DurableOutboxEntry[]): void {
  const identities = new Map<string, string>();
  const byWriter = new Map<string, DurableOutboxEntry[]>();
  for (const entry of entries) {
    assertWriterAndSequence(entry.writerId, entry.sequence);
    if (!/^[0-9a-f]{64}$/.test(entry.repositoryFingerprint)) throw new Error("durable Outbox repository fingerprint is invalid");
    if (entry.id !== entry.commitHash || !/^[0-9a-f]{64}$/.test(entry.commitHash)) throw new Error("durable Outbox identity is invalid");
    if (entry.objects.at(-1)?.kind !== "commit" || entry.objects.at(-1)?.hash !== entry.commitHash) throw new Error("durable Outbox Commit reference is invalid");
    assertObjectOrder(entry.objects);
    assertUniqueMutations(entry.mutations);
    for (const mutation of entry.mutations) {
      if (parseVersionId(mutation.versionId).commitHash !== entry.commitHash) {
        throw new Error("durable Outbox Mutation Version ID belongs to another Commit");
      }
    }
    const sequenceKey = `${entry.writerId}:${entry.sequence}`;
    const existing = identities.get(sequenceKey);
    if (existing !== undefined && existing !== entry.commitHash) throw new Error("durable Outbox reuses a writer sequence");
    identities.set(sequenceKey, entry.commitHash);
    const writerEntries = byWriter.get(entry.writerId) ?? [];
    writerEntries.push(entry);
    byWriter.set(entry.writerId, writerEntries);
  }
  for (const writerEntries of byWriter.values()) {
    const live = writerEntries.filter((entry) => !isTerminal(entry.state)).sort(compareSequence);
    if (live.filter((entry) => entry.state === "publishing").length > 1) throw new Error("a writer has more than one publishing Outbox");
    for (let index = 1; index < live.length; index += 1) {
      if (BigInt(live[index].sequence) !== BigInt(live[index - 1].sequence) + 1n) throw new Error("durable Outbox sequence has a gap");
    }
    const publishingIndex = live.findIndex((entry) => entry.state === "publishing");
    if (publishingIndex > 0) throw new Error("durable Outbox publishing entry is not FIFO");
  }
}

function orderedEnvelopeObjects(envelope: PublishEnvelope): Array<[DurableOutboxObjectKind, readonly ImmutableObject[]]> {
  return [
    ["blob", envelope.blobs],
    ["config-tree", envelope.configTrees],
    ["change-chunk", envelope.chunks],
    ["commit", [envelope.commit]],
  ];
}

async function stageObject(
  stager: OutboxContentStager,
  kind: DurableOutboxObjectKind,
  object: ImmutableObject,
): Promise<DurableOutboxObject> {
  if (!/^[0-9a-f]{64}$/.test(object.hash)) throw new Error(`Outbox ${kind} hash is invalid`);
  const staged = await stager.stage(oneChunk(object.bytes), object.bytes.byteLength);
  if (staged.hash !== object.hash || staged.size !== object.bytes.byteLength) throw new Error(`Outbox ${kind} staging verification mismatch`);
  return { kind, key: object.key, hash: object.hash, size: staged.size, contentRef: staged.ref };
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield new Uint8Array(bytes);
}

function copyMutation(mutation: DurableOutboxMutation): DurableOutboxMutation {
  if (mutation.registerKey.length === 0 || mutation.versionId.length === 0) throw new Error("Outbox Mutation binding is invalid");
  if (mutation.valueHash !== null && !/^[0-9a-f]{64}$/.test(mutation.valueHash)) throw new Error("Outbox Mutation value hash is invalid");
  if (!["put", "delete", "config-snapshot"].includes(mutation.kind) || !Array.isArray(mutation.parents)
    || mutation.parents.some((parent) => typeof parent !== "string" || parent.length === 0)
    || new Set(mutation.parents).size !== mutation.parents.length) {
    throw new Error("Outbox Mutation parents are invalid");
  }
  if (mutation.kind === "delete" && mutation.valueHash !== null) throw new Error("Outbox delete Mutation cannot have a value hash");
  if (mutation.kind !== "delete" && mutation.valueHash === null) throw new Error("Outbox put Mutation needs a value hash");
  for (const generation of [mutation.capturedDirtyGeneration, mutation.capturedEventGeneration]) {
    if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 0)) {
      throw new Error("Outbox Mutation capture generation is invalid");
    }
  }
  return { ...mutation, parents: [...mutation.parents] };
}

function assertUniqueMutations(mutations: readonly DurableOutboxMutation[]): void {
  const keys = new Set<string>();
  const versions = new Set<string>();
  for (const mutation of mutations) {
    copyMutation(mutation);
    if (keys.has(mutation.registerKey) || versions.has(mutation.versionId)) throw new Error("Outbox contains duplicate Mutation bindings");
    keys.add(mutation.registerKey);
    versions.add(mutation.versionId);
  }
}

function assertObjectOrder(objects: readonly DurableOutboxObject[]): void {
  const order: DurableOutboxObjectKind[] = ["blob", "config-tree", "change-chunk", "commit"];
  let previous = -1;
  for (const object of objects) {
    const index = order.indexOf(object.kind);
    if (index < previous) throw new Error("durable Outbox objects are not in publish order");
    previous = index;
  }
}

function assertWriterAndSequence(writerId: string, sequence: string): void {
  if (writerId.length === 0 || !/^[0-9]{20}$/.test(sequence) || sequence === "00000000000000000000") {
    throw new Error("durable Outbox writer or sequence is invalid");
  }
}

function compareSequence(left: DurableOutboxEntry, right: DurableOutboxEntry): number {
  return left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : 0;
}

function isTerminal(state: DurableOutboxState): boolean {
  return state === "published" || state === "integrity-error" || state === "recovery-required";
}

function freezeEntry(entry: DurableOutboxEntry): DurableOutboxEntry {
  return Object.freeze({
    ...entry,
    objects: Object.freeze(entry.objects.map((object) => Object.freeze({ ...object }))) as unknown as DurableOutboxObject[],
    mutations: Object.freeze(entry.mutations.map((mutation) => Object.freeze({ ...mutation, parents: Object.freeze([...mutation.parents]) }))) as unknown as DurableOutboxMutation[],
  });
}
