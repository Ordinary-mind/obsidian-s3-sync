import { localStateRoot } from "./scope";

export interface RepositoryStateLayout {
  root: string;
  owner: string;
  stateCopies: readonly [string, string];
  staged: string;
  outbox: string;
  journals: string;
  recovery: string;
  conflictDrafts: string;
}

export const REPOSITORY_STATE_AREAS = ["staged", "outbox", "journals", "recovery", "conflict-drafts"] as const;
export type RepositoryStateArea = typeof REPOSITORY_STATE_AREAS[number];

export function repositoryStateLayout(configDir: string, repositoryId: string): RepositoryStateLayout {
  const root = localStateRoot(configDir, repositoryId);
  return Object.freeze({
    root,
    owner: `${root}/owner.json`,
    stateCopies: [`${root}/state-a.json`, `${root}/state-b.json`] as const,
    staged: `${root}/staged`,
    outbox: `${root}/outbox`,
    journals: `${root}/journals`,
    recovery: `${root}/recovery`,
    conflictDrafts: `${root}/conflict-drafts`,
  });
}

export function normalizeRepositoryStateReference(
  reference: string,
  allowedAreas: readonly RepositoryStateArea[] = REPOSITORY_STATE_AREAS,
): string {
  if (reference.includes("\\")) throw new Error("repository state reference must use forward slashes");
  if (reference.startsWith("/") || /^[A-Za-z]:/.test(reference)) throw new Error("repository state reference must be relative");
  const segments = reference.split("/");
  if (segments.length < 2 || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("repository state reference is invalid");
  }
  if (!allowedAreas.includes(segments[0] as RepositoryStateArea)) {
    throw new Error("repository state reference uses an unsupported area");
  }
  return segments.join("/");
}

export function resolveRepositoryStateReference(
  layout: RepositoryStateLayout,
  reference: string,
  allowedAreas?: readonly RepositoryStateArea[],
): string {
  return `${layout.root}/${normalizeRepositoryStateReference(reference, allowedAreas)}`;
}

export type ResidualStateDecision = "new-installation" | "resume-existing-state" | "reattach-required" | "refuse-foreign-root";

export function decideResidualStateHandling(input: {
  stateRoot: "missing" | "owned" | "foreign";
  durableState: "missing" | "valid" | "corrupt";
  localHasContent: boolean;
}): ResidualStateDecision {
  if (input.stateRoot === "foreign") return "refuse-foreign-root";
  if (input.stateRoot === "missing") return input.localHasContent ? "reattach-required" : "new-installation";
  if (input.durableState === "valid") return "resume-existing-state";
  return input.localHasContent ? "reattach-required" : "new-installation";
}
