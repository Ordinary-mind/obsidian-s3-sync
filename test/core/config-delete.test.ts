import { describe, expect, it } from "vitest";
import { validateConfigDeleteParents } from "../../core/config-delete";
describe("Config delete causality", () => { it("requires a direct parent Tree to manage each delete", () => {
  expect(validateConfigDeleteParents(["plugins/a/data.json"], [new Set(["plugins/a/data.json"])])).toBe("valid");
  expect(validateConfigDeleteParents(["plugins/a/data.json"], [new Set()])).toBe("invalid");
  expect(validateConfigDeleteParents(["plugins/a/data.json"], [])).toBe("invalid");
}); });
