export type PublishStage = "blob" | "config-tree" | "change-chunk" | "commit";

export class FakePublisher {
  readonly stages: PublishStage[] = [];

  publish(stage: PublishStage): void {
    const order: PublishStage[] = ["blob", "config-tree", "change-chunk", "commit"];
    if (order.indexOf(stage) !== this.stages.length) {
      throw new Error(`publish stage out of order: ${stage}`);
    }
    this.stages.push(stage);
  }
}
