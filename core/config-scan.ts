export interface ConfigScanItem {
  path: string;
  hash: string;
  size: number;
  stagedRef: string;
}

export type ConfigScanObservation =
  | { status: "complete"; scopeRevision: string; items: ConfigScanItem[] }
  | { status: "unknown"; reason: string };

export type StableConfigScanResult =
  | { status: "captured"; scopeRevision: string; items: ConfigScanItem[] }
  | { status: "retry"; reason: "unknown" | "scope-changed" | "content-changed" };

export async function captureStableConfigScan(input: {
  scan: () => Promise<ConfigScanObservation>;
  quietWindow: () => Promise<void>;
}): Promise<StableConfigScanResult> {
  let first: ConfigScanObservation;
  try { first = await input.scan(); }
  catch { return { status: "retry", reason: "unknown" }; }
  if (first.status !== "complete") return { status: "retry", reason: "unknown" };
  try { await input.quietWindow(); }
  catch { return { status: "retry", reason: "unknown" }; }
  let second: ConfigScanObservation;
  try { second = await input.scan(); }
  catch { return { status: "retry", reason: "unknown" }; }
  if (second.status !== "complete") return { status: "retry", reason: "unknown" };
  if (first.scopeRevision !== second.scopeRevision) return { status: "retry", reason: "scope-changed" };
  if (!sameLogicalItems(first.items, second.items)) return { status: "retry", reason: "content-changed" };
  return {
    status: "captured",
    scopeRevision: second.scopeRevision,
    items: second.items.map(copyItem),
  };
}

function sameLogicalItems(left: readonly ConfigScanItem[], right: readonly ConfigScanItem[]): boolean {
  if (left.length !== right.length) return false;
  const leftItems = [...left].sort(compareItem);
  const rightItems = [...right].sort(compareItem);
  return leftItems.every((item, index) => item.path === rightItems[index].path
    && item.hash === rightItems[index].hash
    && item.size === rightItems[index].size);
}

function compareItem(left: ConfigScanItem, right: ConfigScanItem): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function copyItem(item: ConfigScanItem): ConfigScanItem {
  return { ...item };
}
