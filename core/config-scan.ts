export interface ConfigScanItem {
  path: string;
  hash: string;
  size: number;
  stagedRef: string;
}

export type ConfigScanObservation =
  | { status: "complete"; scopeRevision: string; items: ConfigScanItem[] }
  | { status: "unknown"; reason: string; error?: unknown };

export type StableConfigScanResult =
  | { status: "captured"; scopeRevision: string; items: ConfigScanItem[] }
  | { status: "retry"; reason: "unknown" | "scope-changed" | "content-changed"; error?: unknown };

export async function captureStableConfigScan(input: {
  scan: () => Promise<ConfigScanObservation>;
  quietWindow: () => Promise<void>;
}): Promise<StableConfigScanResult> {
  let first: ConfigScanObservation;
  try { first = await input.scan(); }
  catch (error) { return { status: "retry", reason: "unknown", error }; }
  if (first.status !== "complete") return { status: "retry", reason: "unknown", ...(first.error !== undefined ? { error: first.error } : {}) };
  try { await input.quietWindow(); }
  catch (error) { return { status: "retry", reason: "unknown", error }; }
  let second: ConfigScanObservation;
  try { second = await input.scan(); }
  catch (error) { return { status: "retry", reason: "unknown", error }; }
  if (second.status !== "complete") return { status: "retry", reason: "unknown", ...(second.error !== undefined ? { error: second.error } : {}) };
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
