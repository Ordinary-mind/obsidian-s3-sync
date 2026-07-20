import { isOwnApplyEditorEvent, isOwnApplyEvent } from "../core/apply-operation";
import { captureEditorChange, observeEditorDisk } from "../core/editor-latch";
import { latestVaultEvent, recordVaultEvent, recordVaultRename } from "../core/vault-event";
import type { S3SyncData } from "./types";

export interface VaultEventTrackerHost {
  getData(): S3SyncData;
  isManagedPath(path: string): boolean;
  capturePathHash(path: string): Promise<{ hash: string } | undefined>;
  currentApplyOperation(path: string): string | undefined;
  isRecentApplyEvent(path: string, actualHash: string | undefined): boolean;
  persistSoon(): void;
  notifyChange(): void;
}

export class VaultEventTracker {
  constructor(private readonly host: VaultEventTrackerHost) {}

  recordEditorChange(path: string, editorContentHash: string): void {
    const data = this.host.getData();
    if (!data.v1 || !this.host.isManagedPath(path)) return;
    const operationId = this.host.currentApplyOperation(path);
    if (isOwnApplyEditorEvent(data.v1ApplyJournals, operationId, path, editorContentHash)
      || this.host.isRecentApplyEvent(path, editorContentHash)) return;
    if (!data.v1DirtyIntents[path] && data.files[path]?.hash === editorContentHash) return;
    data.v1DirtyIntents[path] = captureEditorChange({
      path,
      projectedHeads: data.v1ProjectedHeads[path] ?? [],
      projectedValueHash: data.files[path]?.hash,
      editorContentHash,
      existing: data.v1DirtyIntents[path],
    });
    this.commit();
  }

  async handleUpsert(path: string): Promise<void> {
    const data = this.host.getData();
    if (!data.v1 || !this.host.isManagedPath(path)) return;
    const applyJournals = data.v1ApplyJournals.map((journal) => ({ ...journal }));
    const operationId = this.host.currentApplyOperation(path);
    const capture = await this.host.capturePathHash(path);
    if (capture && (isOwnApplyEvent(applyJournals, operationId, path, capture.hash)
      || this.host.isRecentApplyEvent(path, capture.hash))) return;
    const intent = data.v1DirtyIntents[path];
    if (capture && !intent && data.files[path]?.hash === capture.hash) return;
    this.appendEvent("upsert", path);
    if (capture && intent) {
      data.v1DirtyIntents[path] = observeEditorDisk(intent, { kind: "put", hash: capture.hash }, false).intent;
    }
    this.commit();
  }

  handleDelete(path: string): void {
    const data = this.host.getData();
    if (!data.v1 || !this.host.isManagedPath(path)) return;
    if (isOwnApplyEvent(data.v1ApplyJournals, this.host.currentApplyOperation(path), path, undefined)
      || this.host.isRecentApplyEvent(path, undefined)) return;
    this.appendEvent("delete", path);
    const intent = data.v1DirtyIntents[path];
    if (intent) data.v1DirtyIntents[path] = observeEditorDisk(intent, { kind: "delete" }, false).intent;
    this.commit();
  }

  handleRename(oldPath: string, newPath: string): void {
    const data = this.host.getData();
    if (!data.v1 || !this.host.isManagedPath(oldPath) || !this.host.isManagedPath(newPath)) return;
    data.v1VaultEvents = recordVaultRename(data.v1VaultEvents, {
      transactionId: crypto.randomUUID(),
      deleteId: crypto.randomUUID(),
      upsertId: crypto.randomUUID(),
      oldPath,
      newPath,
      oldProjectedHeads: data.v1ProjectedHeads[oldPath] ?? [],
      newProjectedHeads: data.v1ProjectedHeads[newPath] ?? [],
      oldPreviousGeneration: data.v1VaultGenerations[oldPath] ?? 0,
      newPreviousGeneration: data.v1VaultGenerations[newPath] ?? 0,
    });
    data.v1VaultGenerations[oldPath] = latestVaultEvent(data.v1VaultEvents, oldPath)!.generation;
    data.v1VaultGenerations[newPath] = latestVaultEvent(data.v1VaultEvents, newPath)!.generation;
    const intent = data.v1DirtyIntents[oldPath];
    if (intent) data.v1DirtyIntents[oldPath] = observeEditorDisk(intent, { kind: "delete" }, false).intent;
    this.commit();
  }

  recordEvent(kind: "upsert" | "delete", path: string): void {
    const data = this.host.getData();
    if (!data.v1 || !this.host.isManagedPath(path)) return;
    this.appendEvent(kind, path);
    this.commit();
  }

  private appendEvent(kind: "upsert" | "delete", path: string): void {
    const data = this.host.getData();
    data.v1VaultEvents = recordVaultEvent(data.v1VaultEvents, {
      id: crypto.randomUUID(),
      kind,
      path,
      projectedHeads: data.v1ProjectedHeads[path] ?? [],
      previousGeneration: data.v1VaultGenerations[path] ?? 0,
    });
    data.v1VaultGenerations[path] = latestVaultEvent(data.v1VaultEvents, path)!.generation;
  }

  private commit(): void {
    this.host.persistSoon();
    this.host.notifyChange();
  }
}
