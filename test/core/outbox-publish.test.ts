import { describe, expect, it } from "vitest";
import { freezeOutboxBytes } from "../../core/outbox";
import { transitionOutboxPublication } from "../../core/outbox-publish";
describe("Outbox publication state", () => { it("retains immutable bytes across retryable publishing failure", () => {
  const queued = { entry: freezeOutboxBytes("c", new Uint8Array([1])), state: "queued" as const };
  const retry = transitionOutboxPublication(transitionOutboxPublication(queued, "publishing"), "retryable-error");
  expect(retry.entry.bytes).toEqual(new Uint8Array([1]));
  expect(transitionOutboxPublication(retry, "publishing").state).toBe("publishing");
}); });
