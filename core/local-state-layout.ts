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
