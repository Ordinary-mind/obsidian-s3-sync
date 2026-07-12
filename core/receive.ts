export type CommitReceiveResult = "accepted" | "pending-dependency" | "isolated-integrity";

export function classifyCommitReceive(input: { envelopeValid: boolean; dependenciesPresent: boolean; dependenciesValid: boolean }): CommitReceiveResult {
  if (!input.envelopeValid || !input.dependenciesValid) return "isolated-integrity";
  return input.dependenciesPresent ? "accepted" : "pending-dependency";
}
