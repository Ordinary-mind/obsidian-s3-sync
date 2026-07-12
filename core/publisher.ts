export type PublishStage = "blob" | "config-tree" | "change-chunk" | "commit";

const order: PublishStage[] = ["blob", "config-tree", "change-chunk", "commit"];

export function assertPublishOrder(completed: readonly PublishStage[], next: PublishStage): void {
  const expected = order[completed.length];
  if (next !== expected) throw new Error(`publish stage out of order: ${next}`);
}

export function publishableStages(input: { blobsReady: boolean; configTreesReady: boolean; chunksReady: boolean }): PublishStage[] {
  const stages: PublishStage[] = [];
  if (input.blobsReady) stages.push("blob");
  if (input.configTreesReady) stages.push("config-tree");
  if (input.chunksReady) stages.push("change-chunk");
  if (input.blobsReady && input.configTreesReady && input.chunksReady) stages.push("commit");
  return stages;
}
