import { describe, expect, it } from "vitest";
import { buildBlobObject } from "../../core/blob";
import { buildVaultChangeEnvelope } from "../../core/commit-builder";
import { objectBodyFromBytes } from "../../core/object-store";
import { auditRemoteRepository, pollRemoteCommitKeys } from "../../core/remote-audit";
import { createRepositoryDescriptor } from "../../core/repository-bootstrap";
import { sha256Hex } from "../../protocol/hash";

describe("recoverable remote repository audit", () => {
  it("rebuilds from immutable remote objects and treats a marker only as a poll filter", async () => {
    const objects = new Map<string, Uint8Array>();
    const store = {
      list: async (prefix: string) => ({ keys: [...objects.keys()].filter((key) => key.startsWith(prefix)).reverse() }),
      head: async (key: string) => ({ size: objects.get(key)!.byteLength }),
      getStream: async (key: string) => {
        const bytes = objects.get(key);
        if (!bytes) throw new Error(`missing ${key}`);
        return objectBodyFromBytes(bytes);
      },
      putImmutable: async (key: string, bytes: Uint8Array) => {
        if (objects.has(key)) throw new Error("exists");
        objects.set(key, new Uint8Array(bytes));
      },
    };
    const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
    const descriptor = await createRepositoryDescriptor(store, { prefix: "", repositoryId, configDir: ".obsidian", historicalConfigDirs: [] });
    const bytes = new Uint8Array([1, 2, 3]);
    const blob = buildBlobObject("", repositoryId, { bytes, size: bytes.byteLength, hash: sha256Hex(bytes) });
    const envelope = buildVaultChangeEnvelope({ prefix: "", repositoryId, descriptorHash: descriptor.descriptorHash, writerId: "123e4567-e89b-42d3-a456-426614174001", sequence: "00000000000000000001", previousCommitHash: null, createdAt: "2026-07-13T00:00:00.000Z", kind: "bootstrap", clientVersion: "0.1.0", mutations: [{ path: "notes/a.md", kind: "put", blob: { hash: blob.hash, size: bytes.byteLength }, parents: [] }] });
    objects.set(blob.key, blob.bytes);
    objects.set(envelope.chunk.key, envelope.chunk.bytes);
    objects.set(envelope.commit.key, envelope.commit.bytes);
    const foreignKey = `.obsidian-s3-sync/v1/repositories/123e4567-e89b-42d3-a456-426614174099/commits/123e4567-e89b-42d3-a456-426614174098/00000000000000000001-${"f".repeat(64)}.json`;
    objects.set(foreignKey, new Uint8Array([9]));

    const audited = await auditRemoteRepository(store, "", repositoryId, descriptor.descriptorHash);
    expect(audited.verifiedObjects).toBe(4);
    expect(audited.repository.register(repositoryId, "vault", "notes/a.md").heads).toHaveLength(1);
    await expect(pollRemoteCommitKeys(store, "", repositoryId, new Set(audited.commitKeys))).resolves.toEqual([]);
    await expect(pollRemoteCommitKeys(store, "", repositoryId)).resolves.toEqual(audited.commitKeys);
    await expect(pollRemoteCommitKeys(store, "", "123e4567-e89b-42d3-a456-426614174099")).resolves.toEqual([foreignKey]);
  });

  it("stops a full audit when any reachable immutable object is tampered", async () => {
    const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
    const store = { list: async () => ({ keys: [] }), head: async () => ({ size: 0 }), getStream: async () => objectBodyFromBytes(new Uint8Array([9])), putImmutable: async () => undefined };
    await expect(auditRemoteRepository(store, "", repositoryId, "a".repeat(64))).rejects.toMatchObject({ kind: "integrity" });
  });
});
