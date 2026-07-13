import type { ConfirmedLocalValue, LocalConcurrentRecord } from "./dirty-record";

export type LocalConcurrentChoice = "editor" | "external" | "merged" | "delete";

export interface LocalConcurrentResolution {
  path: string;
  parents: string[];
  value: ConfirmedLocalValue;
  unselectedContentRefs: string[];
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
