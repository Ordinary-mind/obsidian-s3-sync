import { describe, expect, it } from "vitest";
import { deriveRepositoryHealth } from "../../core/repository-health";

describe("repository health", () => {
  it("does not call a repository healthy while integrity or recovery is unresolved", () => {
    expect(deriveRepositoryHealth({ hasIntegrityFailure: true, hasRecoveryRequired: true, hasPendingDependencies: false })).toBe("integrity-stopped");
    expect(deriveRepositoryHealth({ hasIntegrityFailure: false, hasRecoveryRequired: true, hasPendingDependencies: false })).toBe("recovery-required");
  });
});
