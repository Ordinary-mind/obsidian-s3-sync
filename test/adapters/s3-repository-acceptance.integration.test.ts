import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { S3ObjectStore } from "../../adapters/s3-object-store";
import { buildBlobObject } from "../../core/blob";
import { buildVaultMultiChunkEnvelope } from "../../core/commit-builder";
import { buildConfigSnapshotPublishEnvelope } from "../../core/config-publish-envelope";
import { createDefaultConfigProfile } from "../../core/config-profile";
import type { ProtocolConfigTree } from "../../core/config-tree";
import { auditRemoteRepository } from "../../core/remote-audit";
import { publishEnvelope, putVerifiedImmutable } from "../../core/remote-publish";
import { createRepositoryDescriptor } from "../../core/repository-bootstrap";
import { sha256Hex } from "../../protocol/hash";

const repositoryA = "123e4567-e89b-42d3-a456-426614174100";
const repositoryB = "123e4567-e89b-42d3-a456-426614174200";
const writerA = "123e4567-e89b-42d3-a456-426614174101";
const writerB = "123e4567-e89b-42d3-a456-426614174201";
const createdAt = "2026-07-14T00:00:00.000Z";

describe(`${process.env.S3_TEST_PROVIDER ?? "S3"} repository release acceptance`, () => {
  const store = new S3ObjectStore({
    endpoint: process.env.S3_ENDPOINT!,
    region: process.env.S3_REGION!,
    bucket: process.env.S3_BUCKET!,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
      sessionToken: process.env.S3_SESSION_TOKEN || undefined,
    },
  });
  const prefix = `contract/release/${randomUUID()}`;

  it("resumes a large bootstrap, clones a third client, isolates generations, and restores ConfigTree", async () => {
    const descriptorA = await createRepositoryDescriptor(store, {
      prefix,
      repositoryId: repositoryA,
      configDir: ".obsidian",
      historicalConfigDirs: [],
    });
    const descriptorB = await createRepositoryDescriptor(store, {
      prefix,
      repositoryId: repositoryB,
      configDir: ".obsidian",
      historicalConfigDirs: [],
    });

    const blobs = Array.from({ length: 64 }, (_, index) => {
      const bytes = new TextEncoder().encode(`bootstrap-${index.toString().padStart(3, "0")}`);
      return buildBlobObject(prefix, repositoryA, { bytes, hash: sha256Hex(bytes), size: bytes.byteLength });
    });
    const bootstrap = buildVaultMultiChunkEnvelope({
      prefix,
      repositoryId: repositoryA,
      descriptorHash: descriptorA.descriptorHash,
      writerId: writerA,
      sequence: "00000000000000000001",
      previousCommitHash: null,
      createdAt,
      kind: "bootstrap",
      clientVersion: "0.1.0",
      mutations: blobs.map((blob, index) => ({
        path: `notes/${index.toString().padStart(3, "0")}.md`,
        kind: "put" as const,
        blob: { hash: blob.hash, size: blob.bytes.byteLength },
        parents: [],
      })),
    }, 8);
    expect(bootstrap.chunks).toHaveLength(8);

    await putVerifiedImmutable(store, blobs[0]);
    await putVerifiedImmutable(store, bootstrap.chunks[0]);
    await expect(store.head(bootstrap.commit.key)).rejects.toMatchObject({ kind: "not-found" });
    await publishEnvelope(store, { blobs, configTrees: [], chunks: bootstrap.chunks, commit: bootstrap.commit });

    const configBytes = new TextEncoder().encode('{"theme":"default"}');
    const configHash = sha256Hex(configBytes);
    const tree: ProtocolConfigTree = {
      protocol: 1,
      repositoryId: repositoryA,
      descriptorHash: descriptorA.descriptorHash,
      profile: {
        schema: 1,
        ...createDefaultConfigProfile("1.8.0"),
        minimumTargetAppVersion: "1.8.0",
      },
      enabledCommunityPlugins: [],
      items: [{ path: "app.json", kind: "put", blobHash: configHash, size: configBytes.byteLength }],
    };
    const config = buildConfigSnapshotPublishEnvelope({
      prefix,
      repositoryId: repositoryA,
      descriptorHash: descriptorA.descriptorHash,
      writerId: writerA,
      sequence: "00000000000000000002",
      previousCommitHash: bootstrap.commit.hash,
      createdAt,
      clientVersion: "0.1.0",
      parents: [],
      tree,
      bytesByPath: new Map([["app.json", configBytes]]),
      binding: { configDir: ".obsidian", historicalConfigDirs: [] },
    });
    await publishEnvelope(store, config.envelope);

    const generationBBytes = new TextEncoder().encode("new-generation-only");
    const generationBBlob = buildBlobObject(prefix, repositoryB, {
      bytes: generationBBytes,
      hash: sha256Hex(generationBBytes),
      size: generationBBytes.byteLength,
    });
    const generationB = buildVaultMultiChunkEnvelope({
      prefix,
      repositoryId: repositoryB,
      descriptorHash: descriptorB.descriptorHash,
      writerId: writerB,
      sequence: "00000000000000000001",
      previousCommitHash: null,
      createdAt,
      kind: "bootstrap",
      clientVersion: "0.1.0",
      mutations: [{
        path: "generation-b.md",
        kind: "put",
        blob: { hash: generationBBlob.hash, size: generationBBlob.bytes.byteLength },
        parents: [],
      }],
    });
    await publishEnvelope(store, {
      blobs: [generationBBlob],
      configTrees: [],
      chunks: generationB.chunks,
      commit: generationB.commit,
    });

    const firstClient = await auditRemoteRepository(store, prefix, repositoryA, descriptorA.descriptorHash);
    const thirdClient = await auditRemoteRepository(store, prefix, repositoryA, descriptorA.descriptorHash);
    const newGenerationClient = await auditRemoteRepository(store, prefix, repositoryB, descriptorB.descriptorHash);
    expect(thirdClient.repository.allRegisters(repositoryA)).toEqual(firstClient.repository.allRegisters(repositoryA));
    expect(thirdClient.repository.allRegisters(repositoryA).size).toBe(65);
    expect(thirdClient.repository.register(repositoryA, "config", "portable").heads).toEqual([config.versionId]);
    expect(thirdClient.repository.allRegisters(repositoryA).has("vault:generation-b.md")).toBe(false);
    expect(newGenerationClient.repository.allRegisters(repositoryB).has("vault:generation-b.md")).toBe(true);
    expect(newGenerationClient.repository.allRegisters(repositoryB).has("config:portable")).toBe(false);
  }, 180_000);
});
