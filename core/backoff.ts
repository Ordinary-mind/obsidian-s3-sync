export function retryDelayMs(attempt: number, baseMs = 1000, maxMs = 60_000): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error("invalid retry attempt");
  return Math.min(maxMs, baseMs * 2 ** attempt);
}
