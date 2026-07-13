export type VaultEventKind = "upsert" | "delete";

export interface VaultEventIntent {
  id: string;
  transactionId?: string;
  kind: VaultEventKind;
  path: string;
  generation: number;
  basisHeads: string[];
}

export function recordVaultEvent(
  events: readonly VaultEventIntent[],
  input: { id: string; transactionId?: string; kind: VaultEventKind; path: string; projectedHeads: readonly string[]; previousGeneration?: number },
): VaultEventIntent[] {
  const existing = latestVaultEvent(events, input.path);
  return [...events.map(copyEvent), {
    id: input.id,
    transactionId: input.transactionId,
    kind: input.kind,
    path: input.path,
    generation: Math.max(existing?.generation ?? 0, input.previousGeneration ?? 0) + 1,
    basisHeads: existing ? [...existing.basisHeads] : [...new Set(input.projectedHeads)].sort(),
  }];
}

export function recordVaultRename(
  events: readonly VaultEventIntent[],
  input: { transactionId: string; deleteId: string; upsertId: string; oldPath: string; newPath: string; oldProjectedHeads: readonly string[]; newProjectedHeads: readonly string[]; oldPreviousGeneration?: number; newPreviousGeneration?: number },
): VaultEventIntent[] {
  const withDelete = recordVaultEvent(events, {
    id: input.deleteId,
    transactionId: input.transactionId,
    kind: "delete",
    path: input.oldPath,
    projectedHeads: input.oldProjectedHeads,
    previousGeneration: input.oldPreviousGeneration,
  });
  return recordVaultEvent(withDelete, {
    id: input.upsertId,
    transactionId: input.transactionId,
    kind: "upsert",
    path: input.newPath,
    projectedHeads: input.newProjectedHeads,
    previousGeneration: input.newPreviousGeneration,
  });
}

export function latestVaultEvent(events: readonly VaultEventIntent[], path: string): VaultEventIntent | undefined {
  const latest = events.reduce<VaultEventIntent | undefined>((current, event) => {
    if (event.path !== path) return current;
    return !current || event.generation > current.generation ? event : current;
  }, undefined);
  return latest && copyEvent(latest);
}

export function clearVaultEventsThroughGeneration(events: readonly VaultEventIntent[], path: string, generation: number): VaultEventIntent[] {
  return events.filter((event) => event.path !== path || event.generation > generation).map(copyEvent);
}

function copyEvent(event: VaultEventIntent): VaultEventIntent {
  return { ...event, basisHeads: [...event.basisHeads] };
}
