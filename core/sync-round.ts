export type SyncRoundPhase = "idle" | "recovering" | "verifying-repository" | "pulling" | "merging" | "applying" | "scanning" | "freezing-outbox" | "publishing" | "retrying";

const allowed: Record<SyncRoundPhase, SyncRoundPhase[]> = {
  idle: ["recovering", "retrying"], recovering: ["verifying-repository", "retrying"], "verifying-repository": ["pulling", "retrying"], pulling: ["merging", "retrying"], merging: ["applying", "scanning", "retrying"], applying: ["scanning", "retrying"], scanning: ["freezing-outbox", "retrying"], "freezing-outbox": ["publishing", "idle", "retrying"], publishing: ["idle", "retrying"], retrying: ["idle"],
};

export function advanceSyncRound(current: SyncRoundPhase, next: SyncRoundPhase): SyncRoundPhase {
  if (!allowed[current].includes(next)) throw new Error(`invalid sync round transition: ${current} -> ${next}`);
  return next;
}
