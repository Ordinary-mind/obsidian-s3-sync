import type { ConfirmedLocalValue, LocalConcurrentRecord } from "./dirty-record";

export type LocalConcurrentChoice = "editor" | "external" | "merged" | "delete";

export interface LocalConcurrentResolution {
  path: string;
  parents: string[];
  value: ConfirmedLocalValue;
  unselectedContentRefs: string[];
}

export interface PersistedLocalConcurrentSelection extends LocalConcurrentResolution {
  choice: LocalConcurrentChoice;
  state: "selected" | "published";
}

export interface PersistedLocalConcurrentRecord extends LocalConcurrentRecord {
  selection?: PersistedLocalConcurrentSelection;
}

export function resolveLocalConcurrentRecord(input: {
  record: LocalConcurrentRecord;
  choice: LocalConcurrentChoice;
  mergedValue?: ConfirmedLocalValue;
  confirmedDelete?: ConfirmedLocalValue;
}): LocalConcurrentResolution {
  const { record } = input;
  let value: ConfirmedLocalValue;
  if (input.choice === "editor") value = record.editorValue;
  else if (input.choice === "external") value = record.externalValue;
  else if (input.choice === "merged") {
    if (!input.mergedValue) throw new Error("merged LocalConcurrent resolution needs a staged value");
    value = input.mergedValue;
  } else {
    if (!input.confirmedDelete || input.confirmedDelete.kind !== "delete") throw new Error("delete LocalConcurrent resolution needs confirmed deletion evidence");
    value = input.confirmedDelete;
  }
  return {
    path: record.path,
    parents: [...record.basisHeads],
    value,
    // 未选内容只解除因果引用，不在提交后自动删除其恢复字节。
    unselectedContentRefs: [record.editorValue, record.externalValue]
      .filter((candidate) => candidate !== value && candidate.kind === "put")
      .map((candidate) => (candidate as Extract<ConfirmedLocalValue, { kind: "put" }>).stagedPath),
  };
}

export function selectLocalConcurrentRecordResolution(input: {
  record: PersistedLocalConcurrentRecord;
  choice: LocalConcurrentChoice;
  mergedValue?: ConfirmedLocalValue;
  confirmedDelete?: ConfirmedLocalValue;
}): PersistedLocalConcurrentRecord {
  if (input.record.selection?.state === "published") throw new Error("published LocalConcurrentRecord cannot be selected again");
  const resolution = resolveLocalConcurrentRecord(input);
  return {
    ...input.record,
    basisHeads: [...input.record.basisHeads],
    selection: {
      ...resolution,
      parents: [...resolution.parents],
      value: copyValue(resolution.value),
      unselectedContentRefs: [...resolution.unselectedContentRefs],
      choice: input.choice,
      state: "selected",
    },
  };
}

export function markLocalConcurrentSelectionPublished(record: PersistedLocalConcurrentRecord): PersistedLocalConcurrentRecord {
  if (record.selection?.state !== "selected") throw new Error("LocalConcurrentRecord has no selected resolution");
  return {
    ...record,
    basisHeads: [...record.basisHeads],
    selection: {
      ...record.selection,
      parents: [...record.selection.parents],
      value: copyValue(record.selection.value),
      unselectedContentRefs: [...record.selection.unselectedContentRefs],
      state: "published",
    },
  };
}

export function localConcurrentRecordBlocksAutomaticWork(record: PersistedLocalConcurrentRecord | undefined): boolean {
  return record !== undefined && record.selection?.state !== "published";
}

function copyValue(value: ConfirmedLocalValue): ConfirmedLocalValue {
  return value.kind === "put"
    ? { kind: "put", blob: { ...value.blob }, stagedPath: value.stagedPath }
    : { kind: "delete", evidence: { ...value.evidence } };
}
