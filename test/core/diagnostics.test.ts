import { describe, expect, it } from "vitest";
import { diagnosticCategory } from "../../core/diagnostics";

describe("sync diagnostic categories", () => {
  it("does not collapse integrity and identity failures into generic network errors", () => {
    expect(diagnosticCategory({ code: "integrity-hash-mismatch" })).toBe("integrity");
    expect(diagnosticCategory({ code: "descriptor-mismatch" })).toBe("repository-identity");
    expect(diagnosticCategory({ status: 429 })).toBe("rate-limit");
    expect(diagnosticCategory({ kind: "auth", details: { status: 403 } })).toBe("authentication");
    expect(diagnosticCategory({ name: "SlowDown", $metadata: { httpStatusCode: 503 } })).toBe("rate-limit");
    expect(diagnosticCategory({ code: "local-path-occupied" })).toBe("local-path");
    expect(diagnosticCategory(new Error("active file changed during stable capture"))).toBe("local-path");
    expect(diagnosticCategory(new Error("canonical JSON does not match the protocol object"))).toBe("integrity");
    expect(diagnosticCategory(new Error("persisted Commit frontier anchor is missing"))).toBe("repository-identity");
    expect(diagnosticCategory(new Error("concurrent conflict requires selection"))).toBe("conflict");
    expect(diagnosticCategory(new Error("published Mutation still requires local reconciliation"))).toBe("conflict");
    expect(diagnosticCategory({ kind: "temporary", details: { status: 503 } })).toBe("network");
  });
});
