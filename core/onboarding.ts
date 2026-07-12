export type OnboardingDecision = "empty" | "adopt" | "publish-local-root" | "project-remote" | "conflict";

export function decideOnboarding(localValueHash: string | undefined, remoteValueHash: string | undefined): OnboardingDecision {
  if (localValueHash === undefined && remoteValueHash === undefined) return "empty";
  if (localValueHash === undefined) return "project-remote";
  if (remoteValueHash === undefined) return "publish-local-root";
  return localValueHash === remoteValueHash ? "adopt" : "conflict";
}
