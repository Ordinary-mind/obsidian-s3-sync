export type SyncRoundPhase =
  | "idle"
  | "recovering"
  | "verifying-repository"
  | "pulling"
  | "merging"
  | "applying"
  | "scanning"
  | "repulling"
  | "freezing-outbox"
  | "publishing"
  | "verifying-publication"
  | "retrying";

const allowed: Record<SyncRoundPhase, SyncRoundPhase[]> = {
  idle: ["recovering", "retrying"],
  recovering: ["verifying-repository", "retrying"],
  "verifying-repository": ["pulling", "retrying"],
  pulling: ["merging", "retrying"],
  merging: ["applying", "scanning", "retrying"],
  applying: ["scanning", "retrying"],
  scanning: ["repulling", "retrying"],
  repulling: ["freezing-outbox", "retrying"],
  "freezing-outbox": ["publishing", "verifying-publication", "idle", "retrying"],
  publishing: ["verifying-publication", "retrying"],
  "verifying-publication": ["idle", "retrying"],
  retrying: ["recovering", "idle"],
};

export function advanceSyncRound(current: SyncRoundPhase, next: SyncRoundPhase): SyncRoundPhase {
  if (!allowed[current].includes(next)) throw new Error(`invalid sync round transition: ${current} -> ${next}`);
  return next;
}
