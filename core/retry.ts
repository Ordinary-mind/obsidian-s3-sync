export type RetryDisposition = "retry" | "stop" | "integrity-error";

export function classifyImmutablePutConflict(existingBodyHash: string | undefined, attemptedBodyHash: string): RetryDisposition {
  if (existingBodyHash === undefined) return "retry";
  return existingBodyHash === attemptedBodyHash ? "retry" : "integrity-error";
}

export function classifyObjectReadFailure(kind: "not-found" | "temporary" | "integrity" | "auth"): RetryDisposition {
  if (kind === "integrity") return "integrity-error";
  return kind === "auth" ? "stop" : "retry";
}
