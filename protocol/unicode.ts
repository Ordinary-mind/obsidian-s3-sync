import { unicode151CaseFolding } from "./unicode/15.1.0/case-folding";
import {
  unicode151CanonicalCombiningClass,
  unicode151CanonicalComposition,
  unicode151CanonicalDecomposition,
} from "./unicode/15.1.0/nfc";

export const unicodeVersion = "15.1.0";

export function defaultCaseFold151(value: string): string {
  let folded = "";
  for (const symbol of value) folded += unicode151CaseFolding[symbol] ?? symbol;
  return folded;
}

export function normalizeNfc151(value: string): string {
  const decomposed = [...value].flatMap((symbol) => decompose(symbol.codePointAt(0)!));
  const ordered: number[] = [];
  for (const codePoint of decomposed) {
    const combiningClass = unicode151CanonicalCombiningClass[codePoint] ?? 0;
    let insertion = ordered.length;
    while (
      combiningClass !== 0 &&
      insertion > 0 &&
      (unicode151CanonicalCombiningClass[ordered[insertion - 1]] ?? 0) > combiningClass
    ) {
      insertion -= 1;
    }
    ordered.splice(insertion, 0, codePoint);
  }
  return String.fromCodePoint(...compose(ordered));
}

function decompose(codePoint: number): number[] {
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
    throw new RangeError("Unicode scalar values must not contain surrogates");
  }
  const hangul = decomposeHangul(codePoint);
  if (hangul) return hangul.flatMap(decompose);
  const mapped = unicode151CanonicalDecomposition[codePoint];
  return mapped ? mapped.flatMap(decompose) : [codePoint];
}

function decomposeHangul(codePoint: number): number[] | undefined {
  const sBase = 0xac00;
  const lBase = 0x1100;
  const vBase = 0x1161;
  const tBase = 0x11a7;
  const tCount = 28;
  const nCount = 21 * tCount;
  const sIndex = codePoint - sBase;
  if (sIndex < 0 || sIndex >= 19 * nCount) return undefined;
  const lead = lBase + Math.floor(sIndex / nCount);
  const vowel = vBase + Math.floor((sIndex % nCount) / tCount);
  const trail = sIndex % tCount;
  return trail === 0 ? [lead, vowel] : [lead, vowel, tBase + trail];
}

function compose(codePoints: number[]): number[] {
  if (codePoints.length === 0) return [];
  const result = [codePoints[0]];
  let starterIndex = 0;
  let starter = codePoints[0];
  let lastCombiningClass = unicode151CanonicalCombiningClass[starter] ?? 0;
  for (const candidate of codePoints.slice(1)) {
    const combiningClass = unicode151CanonicalCombiningClass[candidate] ?? 0;
    const composed = composePair(starter, candidate);
    if (composed !== undefined && (lastCombiningClass === 0 || lastCombiningClass < combiningClass)) {
      result[starterIndex] = composed;
      starter = composed;
    } else {
      result.push(candidate);
      if (combiningClass === 0) {
        starterIndex = result.length - 1;
        starter = candidate;
      }
    }
    lastCombiningClass = combiningClass;
  }
  return result;
}

function composePair(starter: number, candidate: number): number | undefined {
  const lBase = 0x1100;
  const vBase = 0x1161;
  const tBase = 0x11a7;
  const tCount = 28;
  const nCount = 21 * tCount;
  const sBase = 0xac00;
  if (starter >= lBase && starter < lBase + 19 && candidate >= vBase && candidate < vBase + 21) {
    return sBase + (starter - lBase) * nCount + (candidate - vBase) * tCount;
  }
  if (
    starter >= sBase &&
    starter < sBase + 19 * nCount &&
    (starter - sBase) % tCount === 0 &&
    candidate > tBase &&
    candidate < tBase + tCount
  ) {
    return starter + candidate - tBase;
  }
  return unicode151CanonicalComposition[`${starter}:${candidate}`];
}
