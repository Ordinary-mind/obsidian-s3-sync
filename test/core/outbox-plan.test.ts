import { describe, expect, it } from "vitest";
import { freezePublishPlan } from "../../core/outbox-plan";
describe("frozen publish plan", () => { it("keeps Commit and dependency bytes immutable after active buffers change", () => {
  const bytes = new Uint8Array([1]);
  const plan = freezePublishPlan({ blobs: [{ key: "b", hash: "b", bytes }], configTrees: [], chunks: [], commit: { key: "c", hash: "c", bytes } });
  bytes[0] = 2;
  expect(plan.envelope.commit.bytes).toEqual(new Uint8Array([1]));
  expect(plan.outboxCommit.bytes).toEqual(new Uint8Array([1]));
}); });
