import { describe, expect, it } from "vitest";
import { createUuidV4 } from "../../core/uuid";

describe("UUIDv4", () => {
  it("uses injected random bytes and forces RFC version and variant bits", () => {
    const uuid = createUuidV4({ getRandomValues: (target) => { target.fill(0); return target; } });
    expect(uuid).toBe("00000000-0000-4000-8000-000000000000");
  });
});
