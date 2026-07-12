export type PublishStage = "blob" | "config-tree" | "change-chunk" | "commit";

const order: PublishStage[] = ["blob", "config-tree", "change-chunk", "commit"];

export function assertPublishOrder(completed: readonly PublishStage[], next: PublishStage): void {
  const expected = order[completed.length];
  if (next !== expected) throw new Error(`publish stage out of order: ${next}`);
}
