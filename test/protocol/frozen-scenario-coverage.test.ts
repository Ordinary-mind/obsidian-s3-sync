import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("design section 21 frozen scenario traceability", () => {
  it("maps every numbered design contract to exact executable test cases", () => {
    const coverage = JSON.parse(readFileSync(new URL("../../protocol/frozen-scenarios.json", import.meta.url), "utf8"));
    const design = readFileSync(new URL("../../design.md", import.meta.url), "utf8");
    const section = design.slice(design.indexOf("## 21."), design.indexOf("本文、`tasks.md`", design.indexOf("## 21.")));
    const designIds = [...section.matchAll(/^([0-9]+)\. /gm)].map((match) => Number(match[1]));
    expect(coverage.designSection).toBe(21);
    expect(designIds).toEqual(Array.from({ length: 28 }, (_, index) => index + 1));
    expect(coverage.scenarios.map((scenario: { id: number }) => scenario.id)).toEqual(designIds);
    for (const scenario of coverage.scenarios as Array<{ id: number; evidence: Array<{ test: string; title: string }> }>) {
      expect(scenario.evidence.length, `scenario ${scenario.id} has no executable evidence`).toBeGreaterThan(0);
      for (const evidence of scenario.evidence) {
        const testUrl = new URL(`../../${evidence.test}`, import.meta.url);
        expect(evidence.test.startsWith("test/"), `scenario ${scenario.id}: ${evidence.test}`).toBe(true);
        expect(existsSync(testUrl), `scenario ${scenario.id}: ${evidence.test}`).toBe(true);
        const source = readFileSync(testUrl, "utf8");
        expect(source.includes(`it("${evidence.title}"`), `scenario ${scenario.id}: ${evidence.title}`).toBe(true);
      }
    }
  });
});
