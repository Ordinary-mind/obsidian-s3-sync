import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("v1 plugin entrypoint contract", () => {
  it("does not initialize or subscribe the legacy manifest sync engine", () => {
    const source = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
    expect(source).toContain('import type { SyncEngine } from "./sync-engine"');
    expect(source).not.toContain("this.registerVaultEvents();");
    expect(source.match(/^\s*this\.rebuildEngine\(\);$/gm) ?? []).toHaveLength(0);
    expect(source).toContain("V1RepositoryService");
  });

  it("routes plugin publications through the durable Outbox", () => {
    const source = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
    expect(source).not.toContain(".publishVaultPut(");
    expect(source).not.toContain(".publishConfigSnapshot(");
    expect(source).toContain("freezeDurableOutboxStateTransaction(");
    expect(source).toContain("service.replayDurableOutbox(");
  });

  it("uses disk-backed stable capture and streamed Outbox replay on the desktop production path", () => {
    const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
    const service = readFileSync(new URL("../../src/v1-service.ts", import.meta.url), "utf8");
    expect(main).toContain("captureStableVaultFileToStaging(");
    expect(main).toContain("new NodeContentStagingAdapter(");
    expect(service).toContain("private readonly objectStore: S3ObjectStore");
    expect(service).toContain("store.putImmutableStream(object.key, openBody");
    expect(service).toContain("verifyVaultBlobDependencies(");
    expect(service).not.toContain("return new S3ObjectStore(");
  });
});
