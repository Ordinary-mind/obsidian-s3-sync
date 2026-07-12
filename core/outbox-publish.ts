import type { ImmutableOutboxEntry } from "./outbox";

export type OutboxPublishState = "queued" | "publishing" | "published" | "retryable-error" | "integrity-error";

export interface OutboxPublication {
  entry: ImmutableOutboxEntry;
  state: OutboxPublishState;
}

export function transitionOutboxPublication(publication: OutboxPublication, state: OutboxPublishState): OutboxPublication {
  const allowed: Record<OutboxPublishState, OutboxPublishState[]> = { queued: ["publishing"], publishing: ["published", "retryable-error", "integrity-error"], published: [], "retryable-error": ["publishing"], "integrity-error": [] };
  if (!allowed[publication.state].includes(state)) throw new Error(`invalid Outbox publish transition: ${publication.state} -> ${state}`);
  return { ...publication, state };
}
