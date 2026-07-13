import type { CommitFrontierAnchor, WriterFrontiers } from "./commit-frontier";
import { repositoryFingerprint, type RepositoryLocator } from "./locator";

export interface RepositoryRuntimeBinding {
  repositoryId: string;
  descriptorHash: string;
  repositoryFingerprint: string;
  locator: RepositoryLocator;
  writerFrontiers: WriterFrontiers;
}

export type RepositoryReconfigureDecision =
  | "unchanged"
  | "verify-route-change"
  | "credentials-only"
  | "reattach-required";

export interface RepositoryCoordinatorControl {
  stopAndFlush(): Promise<void>;
}

export interface RepositoryRouteVerifier {
  verifyDescriptor(binding: RepositoryRuntimeBinding): Promise<void>;
  verifyCommitAnchor(locator: RepositoryLocator, repositoryId: string, descriptorHash: string, anchor: CommitFrontierAnchor): Promise<void>;
}

export function classifyRepositoryReconfigure(input: {
  current: RepositoryRuntimeBinding;
  candidate: Pick<RepositoryRuntimeBinding, "repositoryId" | "descriptorHash" | "locator">;
  credentialsChanged?: boolean;
}): RepositoryReconfigureDecision {
  const { current, candidate } = input;
  if (current.repositoryId !== candidate.repositoryId
    || current.descriptorHash !== candidate.descriptorHash
    || current.locator.bucket !== candidate.locator.bucket
    || current.locator.normalizedPrefix !== candidate.locator.normalizedPrefix) {
    return "reattach-required";
  }
  if (current.locator.endpoint !== candidate.locator.endpoint
    || current.locator.region !== candidate.locator.region
    || current.locator.forcePathStyle !== candidate.locator.forcePathStyle) {
    return "verify-route-change";
  }
  return input.credentialsChanged ? "credentials-only" : "unchanged";
}

export async function applyVerifiedRepositoryRouteChange(input: {
  current: RepositoryRuntimeBinding;
  candidateLocator: RepositoryLocator;
  coordinator: RepositoryCoordinatorControl;
  verifier: RepositoryRouteVerifier;
  persistAtomically(binding: RepositoryRuntimeBinding): Promise<void>;
}): Promise<RepositoryRuntimeBinding> {
  const decision = classifyRepositoryReconfigure({
    current: input.current,
    candidate: {
      repositoryId: input.current.repositoryId,
      descriptorHash: input.current.descriptorHash,
      locator: input.candidateLocator,
    },
  });
  if (decision === "reattach-required") throw new Error("repository identity change requires non-destructive reattachment");
  if (decision === "unchanged") return input.current;
  await input.coordinator.stopAndFlush();
  const candidate: RepositoryRuntimeBinding = {
    ...input.current,
    locator: { ...input.candidateLocator },
    repositoryFingerprint: repositoryFingerprint(input.candidateLocator, input.current.repositoryId, input.current.descriptorHash),
  };
  await input.verifier.verifyDescriptor(candidate);
  for (const anchor of allAnchors(input.current.writerFrontiers)) {
    await input.verifier.verifyCommitAnchor(candidate.locator, candidate.repositoryId, candidate.descriptorHash, anchor);
  }
  await input.persistAtomically(candidate);
  return candidate;
}

export async function applyCredentialRotation<T>(input: {
  currentBinding: RepositoryRuntimeBinding;
  credentials: T;
  coordinator: RepositoryCoordinatorControl;
  verifyCredentials(binding: RepositoryRuntimeBinding, credentials: T): Promise<void>;
  persistCredentials(credentials: T): Promise<void>;
}): Promise<RepositoryRuntimeBinding> {
  await input.coordinator.stopAndFlush();
  await input.verifyCredentials(input.currentBinding, input.credentials);
  await input.persistCredentials(input.credentials);
  return input.currentBinding;
}

function allAnchors(frontiers: WriterFrontiers): CommitFrontierAnchor[] {
  return Object.values(frontiers)
    .flat()
    .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}
