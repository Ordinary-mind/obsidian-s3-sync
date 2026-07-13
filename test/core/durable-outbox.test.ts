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
  transitionDurableOutbox,
  type DurableOutboxEntry,
  type OutboxContentStager,
} from "../../core/durable-outbox";
import type { ImmutableObject } from "../../core/immutable-object";

class MemoryStager implements OutboxContentStager {
  readonly order: string[] = [];
  async stage(chunks: AsyncIterable<Uint8Array>) {
    const values: number[] = [];
    for await (const chunk of chunks) values.push(...chunk);
    const bytes = new Uint8Array(values);
    const hash = sha256Hex(bytes);
    this.order.push(new TextDecoder().decode(bytes));
    return { ref: `staged/${hash}`, hash, size: bytes.byteLength };
  }
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
      writerId: "writer",
      sequence: "00000000000000000001",
      previousCommitHash: null,
      captureGeneration: 7,
      mutations: [{ registerKey: "vault:a.md", versionId: `${commit.hash}:0:0`, valueHash: blob.hash, stagedContentRef: `staged/${blob.hash}` }],
    }, stager);
    blob.bytes[0] = 0;
    expect(stager.order).toEqual(["b", "t", "h", "c"]);
    expect(entry).toMatchObject({ id: commit.hash, commitHash: commit.hash, state: "queued", captureGeneration: 7 });
    expect(entry.objects.at(-1)?.kind).toBe("commit");
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
    expect(reconcilePublishedMutation(reconcile, { kind: "unknown" }, false).state).toBe("pending");
    expect(reconcilePublishedMutation(reconcile, { kind: "put", hash: published.mutations[0].valueHash! }, false).state).toBe("adopted");
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
});

async function entry(sequence: number): Promise<DurableOutboxEntry> {
  const value = sequence.toString();
  const blob = object(`blob-${value}`, `b${value}`);
  const chunk = object(`chunk-${value}`, `h${value}`);
  const commit = object(`commit-${value}`, `c${value}`);
  return freezeDurableOutbox({
    envelope: { blobs: [blob], configTrees: [], chunks: [chunk], commit },
    writerId: "writer",
    sequence: sequence.toString().padStart(20, "0"),
    previousCommitHash: sequence === 1 ? null : "a".repeat(64),
    captureGeneration: sequence,
    mutations: [{ registerKey: "vault:a.md", versionId: `${commit.hash}:0:0`, valueHash: blob.hash }],
  }, new MemoryStager());
}

function object(key: string, body: string): ImmutableObject {
  const bytes = new TextEncoder().encode(body);
  return { key, bytes, hash: sha256Hex(bytes) };
}
