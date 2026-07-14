import { describe, expect, it } from "vitest";
import {
  buildConflictMaterializationPlan,
  createConflictDraft,
  freezeConflictDraftForResolution,
  markConflictDraftPublished,
  materializeConflict,
  mayCleanConflictMaterialization,
  mayPublishOrdinaryConflictPath,
  planConflictDraftMigration,
} from "../../core/conflict-materialization";
import { isVaultPathExcluded } from "../../core/scope";

class MemoryConflictAdapter {
  rootChecked = false;
  readonly directories = new Set<string>();
  readonly bodies = new Map<string, string>();
  readonly metadata = new Map<string, Uint8Array>();
  async ensureOwnedConflictRoot() { this.rootChecked = true; }
  async ensureDirectory(path: string) { this.directories.add(path); }
  async installBodyNoClobber(stagedRef: string, destination: string) {
    const existing = this.bodies.get(destination);
    if (existing !== undefined && existing !== stagedRef) throw new Error("different body");
    this.bodies.set(destination, stagedRef);
    return existing === undefined ? "installed" as const : "already-identical" as const;
  }
  async writeMetadataCanonical(path: string, bytes: Uint8Array) {
    const existing = this.metadata.get(path);
    if (existing && new TextDecoder().decode(existing) !== new TextDecoder().decode(bytes)) throw new Error("different metadata");
    this.metadata.set(path, new Uint8Array(bytes));
  }
}

describe("Vault conflict materialization", () => {
  const repositoryId = "123e4567-e89b-42d3-a456-426614174000";
  const putVersion = `${"a".repeat(64)}:0:0`;
  const deleteVersion = `${"b".repeat(64)}:0:0`;
  const otherPutVersion = `${"d".repeat(64)}:0:0`;

  it("uses deterministic ASCII body names and structured delete intent without touching the logical path", async () => {
    const plan = buildConflictMaterializationPlan({
      repositoryId,
      channel: "vault",
      logicalKeys: ["bad:name?.md"],
      candidates: [
        { kind: "delete", logicalPath: "bad:name?.md", versionId: deleteVersion },
        { kind: "put", logicalPath: "bad:name?.md", versionId: putVersion, blobHash: "c".repeat(64), size: 3, stagedRef: "staged/c" },
        { kind: "put", logicalPath: "bad:name?.md", versionId: otherPutVersion, blobHash: "e".repeat(64), size: 4, stagedRef: "staged/e" },
      ],
    });
    expect(plan.logicalKeys).toEqual(["vault:bad:name?.md"]);
    expect(plan.logicalPaths).toEqual(["bad:name?.md"]);
    expect(plan.bodies[0].destination).toMatch(/^\.s3-sync-conflicts\/[0-9a-f]{64}\/put-[0-9a-f]{64}$/);
    expect(plan.bodies[0].destination).not.toContain("bad:name");
    const decoded = JSON.parse(new TextDecoder().decode(plan.metadataBytes));
    expect(decoded.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "delete", logicalPath: "bad:name?.md", versionId: deleteVersion }),
      expect.objectContaining({ kind: "put", logicalPath: "bad:name?.md", versionId: putVersion }),
    ]));
    const adapter = new MemoryConflictAdapter();
    await materializeConflict(plan, adapter);
    await materializeConflict(plan, adapter);
    expect(adapter.rootChecked).toBe(true);
    expect(adapter.bodies.size).toBe(2);
    expect(isVaultPathExcluded(plan.directory, ".obsidian", [])).toBe(true);
  });

  it("produces identical plans for every client independent of delivery order", () => {
    const candidates = [
      { kind: "put" as const, logicalPath: "a.md", versionId: putVersion, blobHash: "c".repeat(64), size: 1, stagedRef: "staged/c" },
      { kind: "delete" as const, logicalPath: "a.md", versionId: deleteVersion },
    ];
    const left = buildConflictMaterializationPlan({ repositoryId, channel: "vault", logicalKeys: ["a.md"], candidates });
    const right = buildConflictMaterializationPlan({ repositoryId, channel: "vault", logicalKeys: ["a.md"], candidates: [...candidates].reverse() });
    expect(right.conflictId).toBe(left.conflictId);
    expect(right.metadataBytes).toEqual(left.metadataBytes);
  });

  it("rejects invalid put identity and references before materialization", () => {
    const candidate = {
      kind: "put" as const,
      logicalPath: "a.md",
      versionId: putVersion,
      blobHash: "c".repeat(64),
      size: 1,
      stagedRef: "staged/c",
    };
    const build = (overrides: Partial<typeof candidate>) => buildConflictMaterializationPlan({
      repositoryId,
      channel: "vault",
      logicalKeys: ["a.md"],
      candidates: [{ ...candidate, ...overrides }],
    });
    expect(() => build({ blobHash: "invalid" })).toThrow("Blob Hash");
    expect(() => build({ size: 5_000_000_001 })).toThrow("Blob size");
    expect(() => build({ stagedRef: "../outside" })).toThrow("reference");
    expect(() => build({ stagedRef: "recovery/c" })).toThrow("unsupported area");
  });

  it("migrates an unpublished draft as the conflict set expands and cleans only after propagation", () => {
    const draft = createConflictDraft({
      conflictId: "a".repeat(64),
      logicalKeys: ["vault:a.md"],
      contentRef: "conflict-drafts/draft",
      hash: "b".repeat(64),
      size: 1,
    });
    const frozenBeforeExpansion = freezeConflictDraftForResolution(draft, draft);
    const migrated = planConflictDraftMigration(frozenBeforeExpansion, "c".repeat(64), ["vault:a.md", "vault:a.md/child"]);
    expect(migrated).toMatchObject({
      conflictId: "c".repeat(64),
      contentRef: "conflict-drafts/draft",
      logicalKeys: ["vault:a.md", "vault:a.md/child"],
      state: "editing",
    });
    expect(mayPublishOrdinaryConflictPath(migrated, true)).toBe(false);
    expect(() => freezeConflictDraftForResolution(migrated, {
      contentRef: migrated.contentRef,
      hash: "d".repeat(64),
      size: migrated.size,
    })).toThrow("changed");
    const frozen = freezeConflictDraftForResolution(migrated, migrated);
    expect(markConflictDraftPublished(frozen).state).toBe("published");
    expect(mayCleanConflictMaterialization({ resolutionObserved: true, hasUnpublishedDraft: true, hasRecoveryReference: false })).toBe(false);
    expect(mayCleanConflictMaterialization({ resolutionObserved: true, hasUnpublishedDraft: false, hasRecoveryReference: false })).toBe(true);
  });
});
