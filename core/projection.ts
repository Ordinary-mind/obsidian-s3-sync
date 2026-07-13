import type { Generation } from "./generation";

export interface ProjectionState {
  projectedHeads: string[];
  projectedValueHash: string | undefined;
  generation: Generation;
}

export type PathProjection = ProjectionState;

export function adoptProjection(state: ProjectionState, heads: readonly string[], valueHash: string | undefined): ProjectionState {
  return { projectedHeads: [...new Set(heads)].sort(), projectedValueHash: valueHash, generation: state.generation + 1 };
}

export function mayAdvanceProjection(state: ProjectionState, dirtyGeneration: number, currentValueHash: string | undefined, targetValueHash: string | undefined): boolean {
  return dirtyGeneration === state.generation && currentValueHash === targetValueHash;
}
