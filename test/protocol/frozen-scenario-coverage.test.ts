import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("design section 21 frozen scenario traceability", () => {
  it("maps every frozen scenario to an executable test source", () => {
    const coverage = JSON.parse(readFileSync(new URL("../../protocol/frozen-scenarios.json", import.meta.url), "utf8"));
    expect(coverage.designSection).toBe(21);
    expect(coverage.scenarios.map((scenario: { id: number }) => scenario.id)).toEqual(Array.from({ length: 28 }, (_, index) => index + 1));
    for (const scenario of coverage.scenarios as Array<{ id: number; test: string }>) {
      expect(existsSync(new URL(`../../${scenario.test}`, import.meta.url)), `scenario ${scenario.id}: ${scenario.test}`).toBe(true);
    }
  });
});
