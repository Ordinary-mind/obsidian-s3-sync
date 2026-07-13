export interface IncrementalAuditProgress {
  completed: number;
  total: number;
  failures: number;
}

export interface IncrementalAuditResult<T> extends IncrementalAuditProgress {
  status: "complete" | "cancelled";
  failedItems: Array<{ item: T; error: unknown }>;
  deletionEvidenceAllowed: boolean;
}

export async function runIncrementalAudit<T>(input: {
  items: readonly T[];
  verify(item: T, signal: AbortSignal): Promise<void>;
  signal: AbortSignal;
  sliceSize?: number;
  yieldToIdle(): Promise<void>;
  onProgress?(progress: IncrementalAuditProgress): void;
}): Promise<IncrementalAuditResult<T>> {
  const sliceSize = input.sliceSize ?? 128;
  if (!Number.isSafeInteger(sliceSize) || sliceSize < 1) throw new Error("audit slice size is invalid");
  const failedItems: Array<{ item: T; error: unknown }> = [];
  let completed = 0;
  for (const item of input.items) {
    if (input.signal.aborted) return result("cancelled");
    try { await input.verify(item, input.signal); }
    catch (error) {
      if (input.signal.aborted) return result("cancelled");
      failedItems.push({ item, error });
    }
    completed += 1;
    input.onProgress?.({ completed, total: input.items.length, failures: failedItems.length });
    if (completed % sliceSize === 0 && completed < input.items.length) await input.yieldToIdle();
  }
  return result("complete");

  function result(status: "complete" | "cancelled"): IncrementalAuditResult<T> {
    return {
      status,
      completed,
      total: input.items.length,
      failures: failedItems.length,
      failedItems,
      deletionEvidenceAllowed: status === "complete" && failedItems.length === 0 && completed === input.items.length,
    };
  }
}
