export type PullDecision = "create" | "adopt" | "replace" | "conflict";

export function decideResolvedRemotePut(input: {
  localExists: boolean;
  projectedHash: string | undefined;
  currentHash: string | undefined;
  remoteHash: string;
}): PullDecision {
  if (!input.localExists) return "create";
  if (input.currentHash === input.remoteHash) return "adopt";
  if (input.projectedHash !== undefined && input.currentHash === input.projectedHash) return "replace";
  return "conflict";
}
