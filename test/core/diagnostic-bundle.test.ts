import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  appendDiagnosticErrorHistory,
  buildRedactedDiagnosticBundle,
  redactEndpoint,
  type DiagnosticErrorHistoryEntry,
} from "../../core/diagnostic-bundle";

describe("redacted diagnostics and policies", () => {
  it("hashes paths and Prefix while removing credentials, bodies and supplied secrets", () => {
    const bundle = buildRedactedDiagnosticBundle({
      generatedAt: 1,
      repositoryId: "repo",
      normalizedPrefix: "private/vault",
      pathSalt: "salt",
      sensitiveValues: ["super-secret"],
      runtime: {
        pluginVersion: "0.1.0",
        obsidianVersion: "1.7.7",
        platform: "win32",
        architecture: "x64",
        isDesktop: true,
        conflictModalOpenCount: 1,
        lastConflictModalOpenedAt: 1,
      },
      status: {
        accessKeyId: "AKIA1234567890123456",
        body: "vault bytes",
        nested: { token: "super-secret", safe: "ok" },
        decisions: [{ path: "private/note.md", decision: "conflict", reason: "local change" }],
        missingClosure: ["private/protocol/object"],
        recoveryLocation: ".obsidian/private-recovery",
        repositoryId: "repository-private",
        endpoint: "https://user:pass@s3.example.com?token=value",
        bucket: "private-bucket",
      },
      errorHistory: [{
        firstAt: 1,
        lastAt: 1,
        occurrences: 1,
        category: "internal",
        stage: "local-apply",
        message: "token=super-secret",
        report: "password=super-secret https://user:pass@s3.example.com?token=x",
      }],
      events: [{ at: 1, category: "authentication", stage: "GET", message: "password=super-secret https://user:pass@s3.example.com?token=x", path: "private/note.md" }],
    });
    const source = JSON.stringify(bundle);
    expect(source).not.toContain("private/note.md");
    expect(source).not.toContain("private/vault");
    expect(source).not.toContain("private/protocol/object");
    expect(source).not.toContain("private-recovery");
    expect(source).not.toContain("super-secret");
    expect(source).not.toContain("vault bytes");
    expect(source).not.toContain("repository-private");
    expect(source).not.toContain("private-bucket");
    expect(source).not.toContain("s3.example.com");
    expect(bundle.repositoryIdHash).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.events[0].pathHash).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.runtime).toMatchObject({ pluginVersion: "0.1.0", platform: "win32", conflictModalOpenCount: 1 });
    expect(bundle.errorHistory).toHaveLength(1);
    expect(bundle.status).toMatchObject({
      decisions: [{ pathHash: expect.stringMatching(/^[0-9a-f]{64}$/), decision: "conflict", reason: "local change" }],
      missingClosure: [expect.stringMatching(/^[0-9a-f]{64}$/)],
      recoveryLocationHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(redactEndpoint("https://user:pass@s3.example.com?token=x#secret")).toBe("https://s3.example.com");
  });

  it("deduplicates repeated errors while retaining a bounded first-error history", () => {
    const history: DiagnosticErrorHistoryEntry[] = [];
    const first = { category: "internal" as const, stage: "local-apply", message: "拉取失败", report: "report-one" };
    appendDiagnosticErrorHistory(history, { ...first, at: 10 }, 2);
    appendDiagnosticErrorHistory(history, { ...first, at: 20 }, 2);
    appendDiagnosticErrorHistory(history, {
      at: 30,
      category: "local-path",
      stage: "causal-state-persistence",
      message: "保存失败",
      report: "report-two",
    }, 2);

    expect(history).toEqual([
      { firstAt: 10, lastAt: 20, occurrences: 2, ...first },
      {
        firstAt: 30,
        lastAt: 30,
        occurrences: 1,
        category: "local-path",
        stage: "causal-state-persistence",
        message: "保存失败",
        report: "report-two",
      },
    ]);

    appendDiagnosticErrorHistory(history, {
      at: 40,
      category: "network",
      stage: "remote-list",
      message: "网络失败",
      report: "report-three",
    }, 2);
    expect(history.map((entry) => entry.report)).toEqual(["report-two", "report-three"]);
  });

  it("keeps normal and probe cleanup capabilities in separate scoped policies", () => {
    const policy = (name: string) => JSON.parse(readFileSync(new URL(`../../docs/${name}`, import.meta.url), "utf8")) as {
      Statement: Array<{ Action: string | string[]; Resource: string; Condition?: unknown }>;
    };
    const minimal = policy("s3-policy-minimal.json");
    const probe = policy("s3-policy-probe.json");
    const actions = (value: string | string[]) => Array.isArray(value) ? value : [value];
    expect(minimal.Statement.flatMap((statement) => actions(statement.Action))).not.toContain("s3:DeleteObject");
    expect(minimal.Statement.find((statement) => actions(statement.Action).includes("s3:ListBucket"))?.Condition).toBeDefined();
    const probeDeletes = probe.Statement.filter((item) => actions(item.Action).includes("s3:DeleteObject"));
    expect(probeDeletes).toHaveLength(1);
    for (const statement of probeDeletes) {
      expect(statement.Resource.endsWith("/.obsidian-s3-sync/v1/probes/*")).toBe(true);
    }
  });
});
