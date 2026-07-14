import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildRedactedDiagnosticBundle, redactEndpoint } from "../../core/diagnostic-bundle";

describe("redacted diagnostics and policies", () => {
  it("hashes paths and Prefix while removing credentials, bodies and supplied secrets", () => {
    const bundle = buildRedactedDiagnosticBundle({
      generatedAt: 1,
      repositoryId: "repo",
      normalizedPrefix: "private/vault",
      pathSalt: "salt",
      sensitiveValues: ["super-secret"],
      status: {
        accessKeyId: "AKIA1234567890123456",
        body: "vault bytes",
        nested: { token: "super-secret", safe: "ok" },
        decisions: [{ path: "private/note.md", decision: "conflict", reason: "local change" }],
        missingClosure: ["private/protocol/object"],
        recoveryLocation: ".obsidian/private-recovery",
      },
      events: [{ at: 1, category: "authentication", stage: "GET", message: "password=super-secret", path: "private/note.md" }],
    });
    const source = JSON.stringify(bundle);
    expect(source).not.toContain("private/note.md");
    expect(source).not.toContain("private/vault");
    expect(source).not.toContain("private/protocol/object");
    expect(source).not.toContain("private-recovery");
    expect(source).not.toContain("super-secret");
    expect(source).not.toContain("vault bytes");
    expect(bundle.events[0].pathHash).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.status).toMatchObject({
      decisions: [{ pathHash: expect.stringMatching(/^[0-9a-f]{64}$/), decision: "conflict", reason: "local change" }],
      missingClosure: [expect.stringMatching(/^[0-9a-f]{64}$/)],
      recoveryLocationHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(redactEndpoint("https://user:pass@s3.example.com?token=x#secret")).toBe("https://s3.example.com");
  });

  it("keeps DeleteObject out of the normal policy and scopes it in maintenance", () => {
    const minimal = readFileSync(new URL("../../docs/s3-policy-minimal.json", import.meta.url), "utf8");
    const maintenance = readFileSync(new URL("../../docs/s3-policy-maintenance.json", import.meta.url), "utf8");
    expect(minimal).not.toContain("DeleteObject");
    expect(maintenance).toContain("DeleteObject");
    expect(maintenance).toContain("REPLACE_OLD_REPOSITORY_ID");
  });
});
