import { describe, expect, it } from "vitest";
import { decideResolvedRemotePut } from "../../core/pull-decision";

describe("resolved remote put decision", () => {
  it("creates missing files, adopts equal bytes and never overwrites unknown local bytes", () => {
    expect(decideResolvedRemotePut({ localExists: false, projectedHash: undefined, currentHash: undefined, remoteHash: "remote" })).toBe("create");
    expect(decideResolvedRemotePut({ localExists: true, projectedHash: "old", currentHash: "remote", remoteHash: "remote" })).toBe("adopt");
    expect(decideResolvedRemotePut({ localExists: true, projectedHash: "old", currentHash: "old", remoteHash: "remote" })).toBe("replace");
    expect(decideResolvedRemotePut({ localExists: true, projectedHash: "old", currentHash: "local", remoteHash: "remote" })).toBe("conflict");
    expect(decideResolvedRemotePut({ localExists: true, projectedHash: undefined, currentHash: "local", remoteHash: "remote" })).toBe("conflict");
  });
});
