import { unicode151CaseFolding } from "./unicode/15.1.0/case-folding";

export const unicodeVersion = "15.1.0";

export function defaultCaseFold151(value: string): string {
  let folded = "";
  for (const symbol of value) folded += unicode151CaseFolding[symbol] ?? symbol;
  return folded;
}
