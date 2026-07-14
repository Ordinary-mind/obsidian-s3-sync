import { canonicalizeProtocolJson, parseCanonicalProtocolJson } from "../protocol/json";
import { normalizeRepositoryStateReference } from "./local-state-layout";
import { validateRemoteVaultPath } from "./path";
import { parseVersionId } from "./version-id";

export type ConflictResolutionSelectedValue =
  | { kind: "put"; hash: string; stagedRef?: string; size?: number }
  | { kind: "delete" };

export type ConflictResolutionSelection =
  | { action: "select-local"; hash: string; size: number; stagedRef: string }
  | { action: "select-version"; versionId: string; hash: string; size: number }
  | { action: "use-merged"; hash: string; size: number; stagedRef: string }
  | { action: "confirm-delete"; confirmed: true };

export type ConflictResolutionSelectionKind = "local" | "version" | "merged" | "delete";

export interface ConflictResolutionIntent {
  path: string;
  parents: string[];
  selectedValue: ConflictResolutionSelectedValue;
  selectedValueHash?: string;
  selectionKind?: ConflictResolutionSelectionKind;
  selectedVersionId?: string;
}

export function captureConflictResolution(
  path: string,
  observedHeads: readonly string[],
  selected: string | ConflictResolutionSelectedValue,
): ConflictResolutionIntent {
  const parents = canonicalHeads(observedHeads);
  const selectedValue = typeof selected === "string" ? { kind: "put" as const, hash: selected } : copySelectedValue(selected);
  return freezeIntent({
    path,
    parents,
    selectedValue,
    ...(selectedValue.kind === "put" ? { selectedValueHash: selectedValue.hash } : {}),
  });
}

export function captureConflictResolutionCommand(
  path: string,
  observedHeads: readonly string[],
  selection: ConflictResolutionSelection,
): ConflictResolutionIntent {
  const normalizedPath = validateRemoteVaultPath(path);
  const parents = canonicalHeads(observedHeads, true);
  if (selection.action === "confirm-delete") {
    if (selection.confirmed !== true) throw new Error("conflict deletion requires explicit confirmation");
    return freezeIntent({
      path: normalizedPath,
      parents,
      selectedValue: { kind: "delete" },
      selectionKind: "delete",
    });
  }
  assertSelectedBlob(selection.hash, selection.size);
  if (selection.action === "select-version") {
    parseVersionId(selection.versionId);
    if (!parents.includes(selection.versionId)) throw new Error("selected conflict version is not an observed head");
    return freezeIntent({
      path: normalizedPath,
      parents,
      selectedValue: { kind: "put", hash: selection.hash, size: selection.size },
      selectedValueHash: selection.hash,
      selectionKind: "version",
      selectedVersionId: selection.versionId,
    });
  }
  const stagedRef = normalizeRepositoryStateReference(selection.stagedRef, ["staged", "conflict-drafts", "recovery"]);
  return freezeIntent({
    path: normalizedPath,
    parents,
    selectedValue: { kind: "put", hash: selection.hash, size: selection.size, stagedRef },
    selectedValueHash: selection.hash,
    selectionKind: selection.action === "select-local" ? "local" : "merged",
  });
}

export function encodeConflictResolutionIntent(intent: ConflictResolutionIntent): string {
  validateIntentConsistency(intent);
  return canonicalizeProtocolJson({ schemaVersion: 1, ...copyIntent(intent) });
}

export function parseConflictResolutionIntent(source: string): ConflictResolutionIntent {
  const value = parseCanonicalProtocolJson(new TextEncoder().encode(source), 64 * 1024);
  const allowed = new Set([
    "schemaVersion", "path", "parents", "selectedValue", "selectedValueHash", "selectionKind", "selectedVersionId",
  ]);
  if (value.schemaVersion !== 1 || Object.keys(value).some((key) => !allowed.has(key))
    || typeof value.path !== "string" || !Array.isArray(value.parents)
    || value.parents.some((head) => typeof head !== "string") || !isRecord(value.selectedValue)) {
    throw new Error("conflict resolution intent shape is invalid");
  }
  const selectedKeys = Object.keys(value.selectedValue);
  let selectedValue: ConflictResolutionSelectedValue;
  if (value.selectedValue.kind === "delete") {
    if (selectedKeys.length !== 1) throw new Error("delete conflict resolution value is invalid");
    selectedValue = { kind: "delete" };
  } else if (value.selectedValue.kind === "put" && typeof value.selectedValue.hash === "string") {
    if (selectedKeys.some((key) => !["kind", "hash", "stagedRef", "size"].includes(key))) {
      throw new Error("put conflict resolution value is invalid");
    }
    if (value.selectedValue.stagedRef !== undefined && typeof value.selectedValue.stagedRef !== "string") {
      throw new Error("put conflict resolution staged reference is invalid");
    }
    if (value.selectedValue.size !== undefined && (!Number.isSafeInteger(value.selectedValue.size) || (value.selectedValue.size as number) < 0)) {
      throw new Error("put conflict resolution size is invalid");
    }
    selectedValue = {
      kind: "put",
      hash: value.selectedValue.hash,
      ...(value.selectedValue.stagedRef !== undefined ? { stagedRef: value.selectedValue.stagedRef } : {}),
      ...(value.selectedValue.size !== undefined ? { size: value.selectedValue.size as number } : {}),
    };
  } else {
    throw new Error("conflict resolution selected value is invalid");
  }

  const rawParents = value.parents as string[];
  const parents = canonicalHeads(rawParents);
  if (parents.length !== rawParents.length || parents.some((head, index) => head !== rawParents[index])) {
    throw new Error("conflict resolution parents are not canonical");
  }
  const selectionKind = value.selectionKind;
  if (selectionKind !== undefined && !["local", "version", "merged", "delete"].includes(selectionKind as string)) {
    throw new Error("conflict resolution selection kind is invalid");
  }
  if (value.selectedVersionId !== undefined && typeof value.selectedVersionId !== "string") {
    throw new Error("conflict resolution selected Version ID is invalid");
  }
  const intent = freezeIntent({
    path: value.path,
    parents,
    selectedValue,
    ...(value.selectedValueHash !== undefined ? { selectedValueHash: requiredString(value.selectedValueHash, "selectedValueHash") } : {}),
    ...(selectionKind !== undefined ? { selectionKind: selectionKind as ConflictResolutionSelectionKind } : {}),
    ...(value.selectedVersionId !== undefined ? { selectedVersionId: value.selectedVersionId } : {}),
  });
  validateIntentConsistency(intent);
  return intent;
}

export function isResolutionCurrent(intent: ConflictResolutionIntent, observedHeads: readonly string[]): boolean {
  const current = canonicalHeads(observedHeads);
  return current.length === intent.parents.length && current.every((head, index) => head === intent.parents[index]);
}

function canonicalHeads(observedHeads: readonly string[], validate = false): string[] {
  const parents = [...new Set(observedHeads)].sort();
  if (parents.length === 0) throw new Error("conflict resolution requires at least one observed head");
  if (validate) for (const parent of parents) parseVersionId(parent);
  return parents;
}

function validateIntentConsistency(intent: ConflictResolutionIntent): void {
  if (intent.selectedValue.kind === "put") {
    if (intent.selectedValueHash !== intent.selectedValue.hash) throw new Error("conflict resolution selected Hash changed");
  } else if (intent.selectedValueHash !== undefined) {
    throw new Error("delete conflict resolution cannot carry a content Hash");
  }
  if (intent.selectionKind === undefined) {
    if (intent.selectedVersionId !== undefined) throw new Error("legacy conflict resolution cannot select a Version ID");
    return;
  }
  validateRemoteVaultPath(intent.path);
  const canonicalParents = canonicalHeads(intent.parents, true);
  if (canonicalParents.length !== intent.parents.length
    || canonicalParents.some((parent, index) => parent !== intent.parents[index])) {
    throw new Error("conflict resolution parents are not canonical");
  }
  if (intent.selectionKind === "delete") {
    if (intent.selectedValue.kind !== "delete" || intent.selectedVersionId !== undefined) throw new Error("delete conflict resolution is inconsistent");
    return;
  }
  if (intent.selectedValue.kind !== "put" || intent.selectedValue.size === undefined) throw new Error("put conflict resolution is incomplete");
  assertSelectedBlob(intent.selectedValue.hash, intent.selectedValue.size);
  if (intent.selectionKind === "version") {
    if (!intent.selectedVersionId || !intent.parents.includes(intent.selectedVersionId) || intent.selectedValue.stagedRef !== undefined) {
      throw new Error("selected conflict version is inconsistent");
    }
    parseVersionId(intent.selectedVersionId);
  } else if (intent.selectedVersionId !== undefined) {
    throw new Error("local conflict resolution cannot select a Version ID");
  } else if (!intent.selectedValue.stagedRef) {
    throw new Error("local conflict resolution requires staged content");
  } else {
    normalizeRepositoryStateReference(intent.selectedValue.stagedRef, ["staged", "conflict-drafts", "recovery"]);
  }
}

function assertSelectedBlob(hash: string, size: number): void {
  if (!/^[0-9a-f]{64}$/.test(hash) || !Number.isSafeInteger(size) || size < 0) {
    throw new Error("selected conflict content is invalid");
  }
}

function copySelectedValue(value: ConflictResolutionSelectedValue): ConflictResolutionSelectedValue {
  return value.kind === "delete" ? { kind: "delete" } : {
    kind: "put",
    hash: value.hash,
    ...(value.stagedRef !== undefined ? { stagedRef: value.stagedRef } : {}),
    ...(value.size !== undefined ? { size: value.size } : {}),
  };
}

function copyIntent(intent: ConflictResolutionIntent): ConflictResolutionIntent {
  return {
    path: intent.path,
    parents: [...intent.parents],
    selectedValue: copySelectedValue(intent.selectedValue),
    ...(intent.selectedValueHash !== undefined ? { selectedValueHash: intent.selectedValueHash } : {}),
    ...(intent.selectionKind !== undefined ? { selectionKind: intent.selectionKind } : {}),
    ...(intent.selectedVersionId !== undefined ? { selectedVersionId: intent.selectedVersionId } : {}),
  };
}

function freezeIntent(intent: ConflictResolutionIntent): ConflictResolutionIntent {
  const frozen = copyIntent(intent);
  Object.freeze(frozen.parents);
  Object.freeze(frozen.selectedValue);
  return Object.freeze(frozen);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`conflict resolution ${name} is invalid`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
