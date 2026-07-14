import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../protocol/hash";
import {
  assertDurableOutboxQueue,
  createPublishedReconciles,
  forkedWriterDisposition,
  freezeDurableOutbox,
  markWriterForked,
  nextDurableOutbox,
  reconcilePublishedMutation,
  publishedReconcileBlocksAutomaticApply,
  replayFrozenDurableOutbox,
  transitionDurableOutbox,
  type DurableOutboxEntry,
  type OutboxContentStager,
} from "../../core/durable-outbox";
import type { ImmutableObject } from "../../core/immutable-object";

class MemoryStager implements OutboxContentStager {
  readonly order: string[] = [];
  readonly contents = new Map<string, Uint8Array>();
  async stage(chunks: AsyncIterable<Uint8Array>) {
    const values: number[] = [];
    for await (const chunk of chunks) values.push(...chunk);
    const bytes = new Uint8Array(values);
    const hash = sha256Hex(bytes);
    this.order.push(new TextDecoder().decode(bytes));
    const ref = `staged/${hash}`;
    this.contents.set(ref, bytes);
    return { ref, hash, size: bytes.byteLength };
  }
  async verify(ref: string, expected: { hash: string; size: number }) {
    const bytes = this.contents.get(ref);
    if (!bytes || sha256Hex(bytes) !== expected.hash || bytes.byteLength !== expected.size) throw new Error("staged mismatch");
  }
  async read(ref: string) { return stream(this.contents.get(ref)!); }
}

describe("durable Outbox", () => {
  it("freezes every dependency and the Commit in publish order", async () => {
    const stager = new MemoryStager();
    const blob = object("blob", "b");
    const tree = object("tree", "t");
    const chunk = object("chunk", "h");
    const commit = object("commit", "c");
    const entry = await freezeDurableOutbox({
      envelope: { blobs: [blob], configTrees: [tree], chunks: [chunk], commit },
      repositoryFingerprint: "f".repeat(64),
      writerId: "writer",
      sequence: "00000000000000000001",
      previousCommitHash: null,
      captureGeneration: 7,
      mutations: [{ registerKey: "vault:a.md", versionId: `${commit.hash}:0:0`, kind: "put", parents: [], valueHash: blob.hash, stagedContentRef: `staged/${blob.hash}` }],
    }, stager);
    blob.bytes[0] = 0;
    expect(stager.order).toEqual(["b", "t", "h", "c"]);
    expect(entry).toMatchObject({ id: commit.hash, commitHash: commit.hash, state: "queued", captureGeneration: 7 });
    expect(entry.objects.at(-1)?.kind).toBe("commit");
  });

  it("adopts an already verified staged Blob without reading it into the control envelope", async () => {
    const stager = new MemoryStager();
    const blobBytes = new TextEncoder().encode("large staged body");
    const staged = await stager.stage(stream(blobBytes));
    stager.order.length = 0;
    const chunk = object("chunk", "h");
    const commit = object("commit", "c");
    const entry = await freezeDurableOutbox({
      envelope: { blobs: [], configTrees: [], chunks: [chunk], commit },
      preStagedObjects: [{ kind: "blob", key: "blob", hash: staged.hash, size: staged.size, contentRef: staged.ref }],
      repositoryFingerprint: "f".repeat(64),
      writerId: "writer",
      sequence: "00000000000000000001",
      previousCommitHash: null,
      captureGeneration: 1,
      mutations: [{ registerKey: "vault:a.md", versionId: `${commit.hash}:0:0`, kind: "put", parents: [], valueHash: staged.hash }],
    }, stager);
    expect(stager.order).toEqual(["h", "c"]);
    expect(entry.objects[0]).toMatchObject({ kind: "blob", contentRef: staged.ref, size: blobBytes.byteLength });
  });

  it("allows only FIFO publishing, preserves retries, and creates reconcile records after verification", async () => {
    const one = await entry(1);
    const two = await entry(2);
    expect(nextDurableOutbox([two, one], "writer")?.sequence).toBe(one.sequence);
    const publishing = transitionDurableOutbox(one, "publishing");
    expect(() => assertDurableOutboxQueue([two, { ...publishing, sequence: two.sequence }])).toThrow("reuses");
    const retry = transitionDurableOutbox(publishing, "retryable-error");
    expect(nextDurableOutbox([two, retry], "writer")?.id).toBe(retry.id);
    const published = transitionDurableOutbox(transitionDurableOutbox(retry, "publishing"), "published");
    const reconcile = createPublishedReconciles(published)[0];
    expect(publishedReconcileBlocksAutomaticApply([reconcile], reconcile.registerKey)).toBe(true);
    expect(reconcilePublishedMutation(reconcile, { kind: "unknown" }, false).state).toBe("pending");
    const adopted = reconcilePublishedMutation(reconcile, { kind: "put", hash: published.mutations[0].valueHash! }, false);
    expect(adopted.state).toBe("adopted");
    expect(publishedReconcileBlocksAutomaticApply([adopted], reconcile.registerKey)).toBe(false);
    expect(reconcilePublishedMutation(reconcile, { kind: "put", hash: "f".repeat(64) }, false).state).toBe("next-generation");
  });

  it("drains only verified frozen bytes after a writer fork", async () => {
    const one = await entry(1);
    const forked = markWriterForked([one], "writer");
    expect(forked[0].writerDisposition).toBe("forked-draining");
    expect(forkedWriterDisposition(forked, "writer", new Set())).toBe("recovery-required");
    expect(forkedWriterDisposition(forked, "writer", new Set([one.id]))).toBe("drain");
    const published = transitionDurableOutbox(transitionDurableOutbox(forked[0], "publishing"), "published");
    expect(forkedWriterDisposition([published], "writer", new Set([one.id]))).toBe("rotate");
  });

  it("replays only verified frozen references in object order and safely retries after a crash", async () => {
    const stager = new MemoryStager();
    const blob = object("blob", "b");
    const chunk = object("chunk", "h");
    const commit = object("commit", "c");
    const queued = await freezeDurableOutbox({
      envelope: { blobs: [blob], configTrees: [], chunks: [chunk], commit },
      repositoryFingerprint: "f".repeat(64),
      writerId: "writer",
      sequence: "00000000000000000001",
      previousCommitHash: null,
      captureGeneration: 1,
      mutations: [{ registerKey: "vault:a.md", versionId: `${commit.hash}:0:0`, kind: "put", parents: [], valueHash: blob.hash, stagedContentRef: `staged/${blob.hash}` }],
    }, stager);
    const publishing = transitionDurableOutbox(queued, "publishing");
    blob.bytes[0] = 0xff;
    const stored = new Map<string, Uint8Array>();
    const calls: string[] = [];
    let failOnce = true;
    const target = {
      repositoryFingerprint: "f".repeat(64),
      putImmutable: async (item: { key: string }, openBody: () => Promise<AsyncIterable<Uint8Array>>) => {
        calls.push(item.key);
        if (item.key === "chunk" && failOnce) { failOnce = false; throw new Error("crash"); }
        const bytes = await readBytes(await openBody());
        const existing = stored.get(item.key);
        if (existing && !existing.every((byte, index) => byte === bytes[index])) throw new Error("collision");
        stored.set(item.key, bytes);
      },
      verifyRemote: async (item: { key: string; hash: string; size: number }) => {
        const bytes = stored.get(item.key);
        if (!bytes || sha256Hex(bytes) !== item.hash || bytes.byteLength !== item.size) throw new Error("remote mismatch");
      },
    };
    await expect(replayFrozenDurableOutbox(publishing, stager, target)).rejects.toThrow("crash");
    await replayFrozenDurableOutbox(publishing, stager, target);
    expect(calls).toEqual(["blob", "chunk", "blob", "chunk", "commit"]);
    expect(new TextDecoder().decode(stored.get("blob")!)).toBe("b");
    await expect(replayFrozenDurableOutbox(publishing, stager, { ...target, repositoryFingerprint: "e".repeat(64) }))
      .rejects.toThrow("another repository binding");
  });
});

async function entry(sequence: number): Promise<DurableOutboxEntry> {
  const value = sequence.toString();
  const blob = object(`blob-${value}`, `b${value}`);
  const chunk = object(`chunk-${value}`, `h${value}`);
  const commit = object(`commit-${value}`, `c${value}`);
  return freezeDurableOutbox({
    envelope: { blobs: [blob], configTrees: [], chunks: [chunk], commit },
    repositoryFingerprint: "f".repeat(64),
    writerId: "writer",
    sequence: sequence.toString().padStart(20, "0"),
    previousCommitHash: sequence === 1 ? null : "a".repeat(64),
    captureGeneration: sequence,
    mutations: [{ registerKey: "vault:a.md", versionId: `${commit.hash}:0:0`, kind: "put", parents: [], valueHash: blob.hash }],
  }, new MemoryStager());
}

function object(key: string, body: string): ImmutableObject {
  const bytes = new TextEncoder().encode(body);
  return { key, bytes, hash: sha256Hex(bytes) };
}

async function* stream(bytes: Uint8Array): AsyncIterable<Uint8Array> { yield new Uint8Array(bytes); }

async function readBytes(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const values: number[] = [];
  for await (const chunk of body) values.push(...chunk);
  return new Uint8Array(values);
}
