import { describe, expect, it } from "vitest";
import { buildBlobObject } from "../../core/blob";
import { buildVaultChangeEnvelope } from "../../core/commit-builder";
import { ObjectStoreError, objectBodyFromBytes } from "../../core/object-store";
import { auditRemoteRepository, pollRemoteCommitKeys, remoteAuditFailureProgress } from "../../core/remote-audit";
import { createRepositoryDescriptor } from "../../core/repository-bootstrap";
import { sha256Hex } from "../../protocol/hash";
import { canonicalizeProtocolJson } from "../../protocol/json";

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

    const progress: Array<{ completedObjects: number; totalObjects: number; missingClosure: string[] }> = [];
    const audited = await auditRemoteRepository(store, "", repositoryId, descriptor.descriptorHash, {
      onProgress: (value) => progress.push(value),
    });
    expect(audited.verifiedObjects).toBe(4);
    expect(audited).toMatchObject({ totalObjects: 4, missingClosure: [], status: "complete", deletionEvidenceAllowed: true });
    expect(progress.at(-1)).toEqual({ completedObjects: 4, totalObjects: 4, missingClosure: [] });
    expect(audited.repository.register(repositoryId, "vault", "notes/a.md").heads).toHaveLength(1);
    expect(audited.reachableObjects).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: blob.key, kind: "blob", size: 3 }),
      expect.objectContaining({ key: envelope.chunk.key, kind: "change-chunk" }),
      expect.objectContaining({ key: envelope.commit.key, kind: "commit" }),
    ]));
    const head = audited.repository.register(repositoryId, "vault", "notes/a.md").heads[0];
    expect(audited.versionObjectKeys.get(head)).toEqual([blob.key, envelope.chunk.key, envelope.commit.key].sort());
    expect(audited.logicalReferencedBlobBytes).toBe(3);
    await expect(pollRemoteCommitKeys(store, "", repositoryId, new Set(audited.commitKeys))).resolves.toEqual([]);
    await expect(pollRemoteCommitKeys(store, "", repositoryId)).resolves.toEqual(audited.commitKeys);
    await expect(pollRemoteCommitKeys(store, "", "123e4567-e89b-42d3-a456-426614174099")).resolves.toEqual([foreignKey]);
  });

  it("stops a full audit when any reachable immutable object is tampered", async () => {
    const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
    const store = { list: async () => ({ keys: [] }), head: async () => ({ size: 0 }), getStream: async () => objectBodyFromBytes(new Uint8Array([9])), putImmutable: async () => undefined };
    const error = await auditRemoteRepository(store, "", repositoryId, "a".repeat(64)).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({ kind: "integrity", code: "integrity-missing-closure" });
    expect(remoteAuditFailureProgress(error)).toMatchObject({
      completedObjects: 0,
      totalObjects: 1,
      missingClosure: [expect.stringContaining("/format.json")],
    });
  });

  it("rejects a replaced descriptor anchor before interpreting repository contents", async () => {
    const objects = new Map<string, Uint8Array>();
    let listed = false;
    const store = {
      list: async () => { listed = true; return { keys: [] }; },
      head: async (key: string) => ({ size: objects.get(key)!.byteLength }),
      getStream: async (key: string) => objectBodyFromBytes(objects.get(key)!),
      putImmutable: async (key: string, bytes: Uint8Array) => { objects.set(key, new Uint8Array(bytes)); },
    };
    const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
    const descriptor = await createRepositoryDescriptor(store, {
      prefix: "vault",
      repositoryId,
      configDir: ".obsidian",
      historicalConfigDirs: [],
    });
    objects.set(descriptor.key, new TextEncoder().encode(canonicalizeProtocolJson({
      protocol: 1,
      repositoryId,
      configDir: ".config",
      historicalConfigDirs: [".obsidian"],
      hashAlgorithm: "sha256",
      canonicalJson: "RFC8785",
    })));

    await expect(auditRemoteRepository(store, "vault", repositoryId, descriptor.descriptorHash))
      .rejects.toMatchObject({ kind: "integrity", objectKey: descriptor.key });
    expect(listed).toBe(false);
  });

  it("retains partial coverage without claiming a missing closure on a temporary list failure", async () => {
    const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
    const descriptorBytes = new TextEncoder().encode(JSON.stringify({
      canonicalJson: "RFC8785",
      configDir: ".obsidian",
      hashAlgorithm: "sha256",
      historicalConfigDirs: [],
      protocol: 1,
      repositoryId,
    }));
    const descriptorHash = sha256Hex(descriptorBytes);
    const store = {
      list: async () => { throw new ObjectStoreError("temporary", "list", { retries: 3, stage: "request" }); },
      head: async () => ({ size: descriptorBytes.byteLength }),
      getStream: async () => objectBodyFromBytes(descriptorBytes),
      putImmutable: async () => undefined,
    };
    const error = await auditRemoteRepository(store, "", repositoryId, descriptorHash).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({ kind: "temporary", code: "audit-network" });
    expect(remoteAuditFailureProgress(error)).toEqual({ completedObjects: 1, totalObjects: 1, missingClosure: [] });
  });

  it("cancels at an idle slice without creating missing-closure or deletion evidence", async () => {
    const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
    const descriptorBytes = new TextEncoder().encode(JSON.stringify({
      canonicalJson: "RFC8785",
      configDir: ".obsidian",
      hashAlgorithm: "sha256",
      historicalConfigDirs: [],
      protocol: 1,
      repositoryId,
    }));
    const descriptorHash = sha256Hex(descriptorBytes);
    const controller = new AbortController();
    let yields = 0;
    const store = {
      list: async () => ({ keys: [] }),
      head: async () => ({ size: descriptorBytes.byteLength }),
      getStream: async () => objectBodyFromBytes(descriptorBytes),
      putImmutable: async () => undefined,
    };
    const error = await auditRemoteRepository(store, "", repositoryId, descriptorHash, {
      signal: controller.signal,
      sliceSize: 1,
      yieldToIdle: async () => {
        yields += 1;
        controller.abort();
      },
    }).then(() => undefined, (failure: unknown) => failure);
    expect(yields).toBe(1);
    expect(error).toMatchObject({
      name: "RemoteAuditCancelled",
      kind: "cancelled",
      code: "audit-cancelled",
      deletionEvidenceAllowed: false,
    });
    expect(remoteAuditFailureProgress(error)).toEqual({ completedObjects: 1, totalObjects: 1, missingClosure: [] });
  });
});
