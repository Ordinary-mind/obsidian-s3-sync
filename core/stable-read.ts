export interface StableReadObservation { type: "file" | "missing" | "other"; size?: number; hash?: string; }

export function isStableRead(first: StableReadObservation, second: StableReadObservation): boolean {
  return first.type === "file" && second.type === "file" && first.size === second.size && first.hash === second.hash;
}

export function classifyDeletionObservation(observation: StableReadObservation): "confirmed-absent" | "unknown" {
  return observation.type === "missing" ? "confirmed-absent" : "unknown";
}
