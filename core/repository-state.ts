import type { RegisterVersion } from "./register";

export interface RepositoryCoreState {
  schema: 1;
  versions: RegisterVersion[];
}

export function serializeRepositoryState(versions: readonly RegisterVersion[]): string {
  return JSON.stringify({ schema: 1, versions: versions.map((version) => ({ ...version, parents: [...version.parents] })) } satisfies RepositoryCoreState);
}

export function parseRepositoryState(source: string): RepositoryCoreState {
  const value = JSON.parse(source) as RepositoryCoreState;
  if (value.schema !== 1 || !Array.isArray(value.versions)) throw new Error("unsupported repository core state");
  return { schema: 1, versions: value.versions.map((version) => ({ ...version, parents: [...version.parents] })) };
}
