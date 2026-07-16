import { compareUtf8 } from "../protocol/utf8";

export interface VerifiedRegisterObservation {
  key: string;
  heads: string[];
  pending: string[];
  invalid: string[];
  disposition: "resolved" | "concurrent" | "pending" | "invalid";
  valueHash?: string | null;
}

export interface PendingApplyState {
  targetHeads: string[];
  targetValueHash: string | null;
}

export function mergeVerifiedRegisterObservations(
  observations: readonly VerifiedRegisterObservation[],
  projectedHeads: Readonly<Record<string, readonly string[]>>,
): {
  observedRegisters: Record<string, VerifiedRegisterObservation>;
  pendingApply: Record<string, PendingApplyState>;
} {
  const observedRegisters: Record<string, VerifiedRegisterObservation> = {};
  const pendingApply: Record<string, PendingApplyState> = {};
  for (const observation of [...observations].sort((left, right) => compareUtf8(left.key, right.key))) {
    observedRegisters[observation.key] = {
      ...observation,
      heads: [...observation.heads],
      pending: [...observation.pending],
      invalid: [...observation.invalid],
    };
    if (!observation.key.startsWith("vault:") || observation.disposition !== "resolved" || observation.valueHash === undefined) continue;
    const path = observation.key.slice("vault:".length);
    if (!sameSet(observation.heads, projectedHeads[path] ?? [])) {
      pendingApply[path] = { targetHeads: [...observation.heads], targetValueHash: observation.valueHash };
    }
  }
  return { observedRegisters, pendingApply };
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}
