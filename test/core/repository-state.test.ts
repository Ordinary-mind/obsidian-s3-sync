import { describe, expect, it } from "vitest";
import { parseRepositoryState, serializeRepositoryState } from "../../core/repository-state";

describe("repository core durable state", () => {
  it("round-trips versions without retaining mutable parent arrays", () => {
    const versions = [{ repositoryId: "repo", channel: "vault" as const, logicalKey: "a", versionId: "v", parents: ["p"] }];
    const parsed = parseRepositoryState(serializeRepositoryState(versions));
    versions[0].parents[0] = "changed";
    expect(parsed.versions[0].parents).toEqual(["p"]);
  });
});
