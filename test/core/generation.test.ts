import { describe, expect, it } from "vitest";
import { reconcilePublishedValue } from "../../core/generation";
describe("published reconcile", () => { it("does not clear dirty state when local bytes changed after publication", () => {
  const published = { publishedVersionId: "v", publishedValueHash: "published" };
  expect(reconcilePublishedValue(published, "published")).toBe("adopt");
  expect(reconcilePublishedValue(published, "new-edit")).toBe("create-next-generation");
  expect(reconcilePublishedValue(published, undefined)).toBe("keep-pending");
}); });
