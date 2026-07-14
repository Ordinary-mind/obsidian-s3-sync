import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ObjectStoreError } from "../../core/object-store";
import { logSafeError, safeErrorMessage, safeErrorRecord } from "../../core/safe-error";

describe("safe runtime errors", () => {
  it("uses fixed user text instead of raw messages, stacks, causes or secrets", () => {
    const secret = "secret=do-not-log";
    const error = new Error(`failed /private/note.md ${secret}`, { cause: new Error("response body") });
    error.stack = `Error: ${secret}\n at /private/note.md`;
    const message = safeErrorMessage(error);
    expect(message).toBe("网络请求失败；请检查连接后重试。");
    expect(JSON.stringify({ message, record: safeErrorRecord(error) })).not.toMatch(/do-not-log|private|response body/);
  });

  it("retains only bounded request metadata from ObjectStore failures", () => {
    const error = new ObjectStoreError("throttled", "get", {
      status: 429,
      requestId: "request-123",
      retries: 3,
      stage: "request",
    });
    expect(safeErrorRecord(error)).toEqual({
      category: "rate-limit",
      operation: "get",
      stage: "request",
      status: 429,
      requestId: "request-123",
      retries: 3,
    });
    expect(safeErrorMessage(error)).toBe("服务端正在限流；请等待退避后重试。（get/request）");
  });

  it("logs only the safe record", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSafeError("S3 Sync operation failed", new Error("token=private-value"));
    expect(spy).toHaveBeenCalledWith("S3 Sync operation failed", { category: "network" });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("private-value");
    spy.mockRestore();
  });

  it("keeps raw errors and causes out of every runtime UI entrypoint", () => {
    for (const path of ["main.ts", "settings-tab.ts", "config-center-modal.ts", "conflict-modal.ts"]) {
      const source = readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");
      expect(source).not.toContain("console.error(");
      expect(source).not.toMatch(/error\.stack|error\.cause|String\(error\)|error instanceof Error \? error\.message/);
    }
    const objectStore = readFileSync(new URL("../../core/object-store.ts", import.meta.url), "utf8");
    const remoteAudit = readFileSync(new URL("../../core/remote-audit.ts", import.meta.url), "utf8");
    expect(`${objectStore}\n${remoteAudit}`).not.toMatch(/super\([^\n]*\{ cause|readonly cause|cause:/);
  });
});
