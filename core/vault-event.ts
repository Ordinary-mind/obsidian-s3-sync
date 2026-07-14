export type VaultEventKind = "upsert" | "delete";

export interface VaultEventIntent {
  id: string;
  transactionId?: string;
  kind: VaultEventKind;
  path: string;
  generation: number;
  basisHeads: string[];
  localPredecessorVersion?: string;
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

export function bindRootDeletePredecessor(
  events: readonly VaultEventIntent[],
  path: string,
  afterGeneration: number,
  localPredecessorVersion: string,
): VaultEventIntent[] {
  return events.map((event) => event.path === path && event.kind === "delete" && event.generation > afterGeneration
    ? { ...copyEvent(event), basisHeads: [], localPredecessorVersion }
    : copyEvent(event));
}

export function bindVaultEventsAfterPublication(
  events: readonly VaultEventIntent[],
  path: string,
  afterGeneration: number,
  localPredecessorVersion: string,
): VaultEventIntent[] {
  return events.map((event) => event.path === path && event.generation > afterGeneration
    ? { ...copyEvent(event), basisHeads: [], localPredecessorVersion }
    : copyEvent(event));
}

export function mergeVaultEventsAfterPublication(
  persisted: readonly VaultEventIntent[],
  observed: readonly VaultEventIntent[],
  path: string,
  afterGeneration: number,
  localPredecessorVersion: string,
): VaultEventIntent[] {
  const order: string[] = [];
  const byId = new Map<string, VaultEventIntent>();
  for (const event of [...persisted, ...observed]) {
    const existing = byId.get(event.id);
    if (!existing) order.push(event.id);
    else if (existing.path !== event.path || existing.kind !== event.kind
      || existing.generation !== event.generation || existing.transactionId !== event.transactionId) {
      throw new Error("Vault event identity changed while merging publication state");
    }
    byId.set(event.id, copyEvent(event));
  }
  return bindVaultEventsAfterPublication(
    clearVaultEventsThroughGeneration(order.map((id) => byId.get(id)!), path, afterGeneration),
    path,
    afterGeneration,
    localPredecessorVersion,
  );
}

function copyEvent(event: VaultEventIntent): VaultEventIntent {
  return { ...event, basisHeads: [...event.basisHeads] };
}
