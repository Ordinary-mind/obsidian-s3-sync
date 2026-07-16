import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ObjectStoreError } from "../../core/object-store";
import { DiagnosticError } from "../../core/diagnostics";
import { RepositoryConfigurationError } from "../../core/locator";
import { withDurableOutboxReplayStage } from "../../core/durable-outbox";
import { SyncPreflightError } from "../../core/sync-preflight";
import {
  logSafeError,
  safeConnectionErrorMessage,
  safeConnectionErrorReport,
  safeErrorMessage,
  safeErrorRecord,
  safeSyncErrorMessage,
  safeSyncErrorReport,
  withConnectionFlowStage,
  withConnectionInitializationStep,
  withLocalPersistenceStep,
  withSyncFlowStage,
} from "../../core/safe-error";

describe("safe runtime errors", () => {
  it("uses fixed user text instead of raw messages, stacks, causes or secrets", () => {
    const secret = "secret=do-not-log";
    const error = new Error(`failed /private/note.md ${secret}`, { cause: new Error("response body") });
    error.stack = `Error: ${secret}\n at /private/note.md`;
    const message = safeErrorMessage(error);
    expect(message).toBe("插件内部流程失败；请求不一定已经发出。请复制错误报告供开发排查。");
    expect(JSON.stringify({ message, record: safeErrorRecord(error) })).not.toMatch(/do-not-log|private|response body/);
    expect(safeSyncErrorReport(error)).not.toMatch(/do-not-log|private|response body/);
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
    expect(safeConnectionErrorMessage(error)).toBe(
      "S3 服务正在限流或暂时不可用；请稍后重试。（操作=GET，阶段=request，HTTP=429，重试=3，RequestId=request-123）",
    );
  });

  it("explains connection configuration failures without copying raw settings or secrets", () => {
    const error = new RepositoryConfigurationError("endpoint", "origin-only");
    const message = safeConnectionErrorMessage(error);
    const report = safeConnectionErrorReport(error);
    expect(message).toBe("Endpoint 只能包含协议、主机和可选端口；请移除末尾 /、Bucket、路径、查询参数及用户名密码。");
    expect(JSON.parse(report)).toMatchObject({
      type: "s3-sync-connection-error",
      schemaVersion: 3,
      message,
      category: "repository-identity",
      reasonCode: "configuration-endpoint-origin-only",
      configurationField: "endpoint",
      configurationIssue: "origin-only",
    });
    expect(JSON.parse(report).code).toContain("CONFIGURATION_ENDPOINT_ORIGIN_ONLY");
    expect(report).not.toMatch(/access.?key|secret|https?:\/\//i);
  });

  it("identifies missing credentials without copying credential values", () => {
    const error = withConnectionFlowStage(
      "configuration",
      new RepositoryConfigurationError("secret-access-key", "required"),
    );
    expect(JSON.parse(safeConnectionErrorReport(error))).toMatchObject({
      type: "s3-sync-connection-error",
      schemaVersion: 3,
      message: "Secret Access Key 未填写；复制的错误报告不会包含凭证值。（流程=configuration）",
      category: "authentication",
      reasonCode: "configuration-secret-access-key-required",
      connectionStage: "configuration",
      configurationField: "secret-access-key",
      configurationIssue: "required",
    });
  });

  it("distinguishes saved binding and local S3 client initialization failures", () => {
    const savedBinding = withConnectionFlowStage(
      "configuration",
      withConnectionInitializationStep("saved-repository-binding", new Error("private state")),
    );
    expect(safeErrorRecord(savedBinding)).toEqual({
      category: "repository-identity",
      connectionStage: "configuration",
      initializationStep: "saved-repository-binding",
    });
    expect(safeConnectionErrorMessage(savedBinding)).toBe(
      "本机仓库绑定不完整；Endpoint、Region 和 Bucket 尚未发起检测。请重新执行“检测并应用”。（流程=configuration，初始化=saved-repository-binding）",
    );

    const client = withConnectionFlowStage(
      "configuration",
      withConnectionInitializationStep("s3-client", new Error("private runtime")),
    );
    expect(safeConnectionErrorMessage(client)).toBe(
      "S3 客户端在本机初始化失败，请求尚未发出；这是插件运行时或 Bundle 初始化问题，不是网络连通性错误。（流程=configuration，初始化=s3-client）",
    );
    expect(safeConnectionErrorReport(client)).not.toMatch(/private runtime|private state/);
  });

  it("identifies the exact local persistence step without copying its raw failure", () => {
    const error = withConnectionFlowStage(
      "settings-apply",
      withLocalPersistenceStep("plugin-data-validation", new Error("private config value")),
    );
    expect(safeErrorRecord(error)).toEqual({
      category: "local-path",
      connectionStage: "settings-apply",
      persistenceStep: "plugin-data-validation",
    });
    expect(safeConnectionErrorMessage(error)).toBe(
      "远端检测已通过，但本地 data.json 在写入前未通过安全边界校验；未写入新配置。（流程=settings-apply，本地保存=plugin-data-validation）",
    );
    expect(safeConnectionErrorReport(error)).not.toContain("private config value");
  });

  it("explains aggregate atomic-create probe failures", () => {
    const error = new ObjectStoreError("integrity", "put", {
      retries: 0,
      stage: "atomic-create-multiple-winners",
    });
    expect(safeConnectionErrorMessage(error)).toBe(
      "存储同时接受了两个不同正文的条件 PUT，不满足当前协议的原子不可变写入要求。（操作=PUT，阶段=atomic-create-multiple-winners，重试=0）",
    );
  });

  it("reports structural path conflicts before any local apply", () => {
    const error = withSyncFlowStage(
      "pull",
      "path-planning",
      new DiagnosticError(
        "REMOTE_STRUCTURAL_PATH_CONFLICT",
        "conflict",
        "remote and local paths contain a file/directory collision or portable case alias; no local bytes were changed",
      ),
    );
    expect(safeSyncErrorMessage(error)).toBe(
      "拉取失败：检测到文件/目录碰撞或大小写别名；本轮尚未写入本地，请先处理结构冲突。（动作=pull，流程=path-planning）",
    );
    expect(JSON.parse(safeSyncErrorReport(error))).toMatchObject({
      code: expect.stringContaining("REMOTE_STRUCTURAL_PATH_CONFLICT"),
      reasonCode: "REMOTE_STRUCTURAL_PATH_CONFLICT",
      category: "conflict",
      syncStage: "path-planning",
    });
    expect(safeSyncErrorReport(error)).not.toMatch(/notes\/|private\.md/);
  });

  it("always records the connection flow stage while preserving request metadata", () => {
    const busy = withConnectionFlowStage("operation-lock", new Error("private busy reason"));
    expect(safeConnectionErrorMessage(busy)).toBe(
      "已有同步、校验或仓库操作正在运行；请等待其结束后重试。（流程=operation-lock）",
    );
    const request = withConnectionFlowStage("write-probe", new ObjectStoreError("temporary", "put", {
      status: 409,
      requestId: "request-409",
      retries: 3,
      stage: "conditional-create",
    }));
    expect(safeErrorRecord(request)).toEqual({
      category: "network",
      connectionStage: "write-probe",
      operation: "put",
      stage: "conditional-create",
      status: 409,
      requestId: "request-409",
      retries: 3,
    });
    expect(safeConnectionErrorReport(request)).not.toContain("private busy reason");
  });

  it("reports the exact push stage and bounded S3 request metadata", () => {
    const requestError = Object.assign(new ObjectStoreError("temporary", "put", {
      status: 503,
      requestId: "request-503",
      retries: 2,
      stage: "request",
    }), { responseBody: "private upstream response" });
    const error = withSyncFlowStage("push", "publication", requestError);
    const message = safeSyncErrorMessage(error);
    expect(safeErrorRecord(error)).toEqual({
      category: "network",
      syncAction: "push",
      syncStage: "publication",
      operation: "put",
      stage: "request",
      status: 503,
      requestId: "request-503",
      retries: 2,
    });
    expect(message).toBe(
      "上传失败：远端对象或提交上传失败；本地 Outbox 已保留，可安全重试。 S3 PUT 请求失败；请检查 PutObject 权限和 If-None-Match: * 条件写兼容性。（动作=push，流程=publication，操作=PUT，阶段=request，HTTP=503，重试=2，RequestId=request-503）",
    );
    expect(safeErrorMessage(error)).toBe(message);
    expect(JSON.parse(safeSyncErrorReport(error))).toMatchObject({
      type: "s3-sync-operation-error",
      schemaVersion: 3,
      message,
      category: "network",
      syncAction: "push",
      syncStage: "publication",
      operation: "put",
      stage: "request",
      status: 503,
      requestId: "request-503",
      retries: 2,
    });
    expect(safeSyncErrorReport(error)).not.toContain("private upstream response");
  });

  it("reports the exact Outbox recovery stage without exposing a local staging path", () => {
    const localError = Object.assign(new Error("ENOENT D:/private/staged/body"), {
      code: "ENOENT",
      path: "D:/private/staged/body",
    });
    const error = withSyncFlowStage(
      "pull",
      "outbox-replay",
      withDurableOutboxReplayStage("staged-verify", localError),
    );
    expect(safeErrorRecord(error)).toEqual({
      category: "local-path",
      syncAction: "pull",
      syncStage: "outbox-replay",
      outboxStage: "staged-verify",
      reasonCode: "ENOENT",
    });
    expect(safeSyncErrorMessage(error)).toBe(
      "拉取失败：旧上传的本地暂存内容不可用，远端也没有可验证的完整副本；写入已停止，请复制报告供开发排查。（动作=pull，流程=outbox-replay，Outbox阶段=staged-verify）",
    );
    expect(safeSyncErrorReport(error)).not.toMatch(/private|staged\/body/i);
  });

  it("reports the exact preflight blocker without turning it into a generic network failure", () => {
    const error = withSyncFlowStage(
      "pull",
      "preflight",
      new SyncPreflightError("apply-journal-recovery"),
    );
    expect(safeErrorRecord(error)).toEqual({
      category: "local-path",
      syncAction: "pull",
      syncStage: "preflight",
      preflightBlocker: "apply-journal-recovery",
    });
    expect(safeSyncErrorMessage(error)).toBe(
      "拉取失败：检测到未完成的本地文件安全应用；原文件前像已保留，请在状态页核对恢复记录。（动作=pull，流程=preflight，阻断=apply-journal-recovery）",
    );
  });

  it("preserves S3 request metadata while checking a remote Outbox recovery copy", () => {
    const error = withSyncFlowStage(
      "push",
      "outbox-replay",
      withDurableOutboxReplayStage("remote-recovery-check", new ObjectStoreError("temporary", "get", {
        status: 503,
        requestId: "recovery-request",
        retries: 2,
        stage: "request",
      })),
    );
    expect(safeErrorRecord(error)).toMatchObject({
      category: "network",
      outboxStage: "remote-recovery-check",
      operation: "get",
      status: 503,
      requestId: "recovery-request",
    });
    expect(safeSyncErrorMessage(error)).toContain("检查远端恢复副本时请求失败");
  });

  it("identifies a failed read-only proof for a terminal Outbox", () => {
    const error = withSyncFlowStage(
      "pull",
      "outbox-replay",
      withDurableOutboxReplayStage("terminal-remote-verify", new ObjectStoreError("integrity", "get", {
        retries: 0,
        stage: "hash",
      })),
    );
    expect(safeErrorRecord(error)).toMatchObject({
      category: "integrity",
      syncStage: "outbox-replay",
      outboxStage: "terminal-remote-verify",
      operation: "get",
      stage: "hash",
    });
    expect(safeSyncErrorMessage(error)).toContain("终止 Outbox 的远端不可变对象未全部通过 Hash/大小回读");
  });

  it("describes conflict detection without copying a private Vault path", () => {
    const error = withSyncFlowStage(
      "push",
      "conflict-check",
      new Error("local and remote conflict at /private/vault/note.md"),
    );
    expect(safeSyncErrorMessage(error)).toBe(
      "上传失败：发布前发现本地与远端均有变化；请先处理冲突。（动作=push，流程=conflict-check）",
    );
    expect(safeSyncErrorReport(error)).not.toMatch(/private|vault|note\.md/i);
  });

  it("logs only the safe record", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSafeError("S3 Sync operation failed", new Error("token=private-value"));
    expect(spy).toHaveBeenCalledWith("S3 Sync operation failed", { category: "internal" });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("private-value");
    spy.mockRestore();
  });

  it("keeps raw errors and causes out of every runtime UI entrypoint", () => {
    for (const path of ["main.ts", "settings-tab.ts", "config-center-modal.ts", "conflict-modal.ts"]) {
      const source = readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");
      expect(source).not.toContain("console.error(");
      expect(source).not.toMatch(/error\.stack|error\.cause|String\(error\)|error instanceof Error \? error\.message/);
    }
    const report = safeSyncErrorReport(withSyncFlowStage(
      "pull",
      "remote-list",
      new ObjectStoreError("temporary", "list", { retries: 1, stage: "request" }, new Error("token=private-cause")),
    ));
    expect(report).toContain("ObjectStoreError");
    expect(report).not.toContain("private-cause");
  });
});
