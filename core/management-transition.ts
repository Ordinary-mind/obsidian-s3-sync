import type { LocalPresence } from "./presence";

export type ManagementTransition = "unchanged" | "publish-put" | "publish-delete" | "stop-managing" | "retry";

export function decideManagementTransition(input: {
  wasManaged: boolean;
  isManaged: boolean;
  presence: LocalPresence;
  contentChanged: boolean;
  hasDeletionEvidence: boolean;
}): ManagementTransition {
  if (input.wasManaged && !input.isManaged) return "stop-managing";
  if (!input.isManaged || input.presence === "out-of-scope") return "unchanged";
  if (input.presence === "unknown") return "retry";
  if (input.presence === "confirmed-absent") return input.hasDeletionEvidence ? "publish-delete" : "retry";
  return input.contentChanged ? "publish-put" : "unchanged";
}
