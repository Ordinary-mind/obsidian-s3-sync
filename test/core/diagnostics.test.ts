import { describe, expect, it } from "vitest";
import { diagnosticCategory } from "../../core/diagnostics";

describe("sync diagnostic categories", () => {
  it("does not collapse integrity and identity failures into generic network errors", () => {
    expect(diagnosticCategory({ code: "integrity-hash-mismatch" })).toBe("integrity");
    expect(diagnosticCategory({ code: "descriptor-mismatch" })).toBe("repository-identity");
    expect(diagnosticCategory({ status: 429 })).toBe("rate-limit");
  });
});
