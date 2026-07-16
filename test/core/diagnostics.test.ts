import { describe, expect, it } from "vitest";
import { DiagnosticError, diagnosticCategory } from "../../core/diagnostics";
import { ObjectStoreError } from "../../core/object-store";

describe("sync diagnostic categories", () => {
  it("does not collapse integrity and identity failures into generic network errors", () => {
    expect(diagnosticCategory(new ObjectStoreError("integrity", "get", { retries: 0, stage: "hash" }))).toBe("integrity");
    expect(diagnosticCategory(new DiagnosticError("DESCRIPTOR_MISMATCH", "repository-identity", "descriptor mismatch"))).toBe("repository-identity");
    expect(diagnosticCategory({ status: 429 })).toBe("rate-limit");
    expect(diagnosticCategory(new Error("network timeout"))).toBe("internal");
    expect(diagnosticCategory({ kind: "auth", details: { status: 403 } })).toBe("authentication");
    expect(diagnosticCategory({ kind: "throttled", name: "SlowDown", $metadata: { httpStatusCode: 503 } })).toBe("rate-limit");
    expect(diagnosticCategory(new DiagnosticError("LOCAL_PATH_OCCUPIED", "local-path", "occupied"))).toBe("local-path");
    expect(diagnosticCategory({ code: "ENOENT", message: "missing staged content" })).toBe("local-path");
    expect(diagnosticCategory(new Error("active file changed during stable capture"))).toBe("internal");
    expect(diagnosticCategory(new Error("canonical JSON does not match the protocol object"))).toBe("internal");
    expect(diagnosticCategory(new Error("persisted Commit frontier anchor is missing"))).toBe("internal");
    expect(diagnosticCategory(new Error("concurrent conflict requires selection"))).toBe("internal");
    expect(diagnosticCategory(new Error("published Mutation still requires local reconciliation"))).toBe("internal");
    expect(diagnosticCategory({ kind: "connection-configuration" })).toBe("repository-identity");
    expect(diagnosticCategory({ kind: "temporary", details: { status: 503 } })).toBe("network");
  });
});
