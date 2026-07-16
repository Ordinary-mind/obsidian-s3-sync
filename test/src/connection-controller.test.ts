import { describe, expect, it, vi } from "vitest";
import { createDefaultConfigProfile } from "../../core/config-profile";
import { createRepositoryLocator } from "../../core/locator";
import { createPersistedRepositoryBinding } from "../../core/repository-binding";
import { safeErrorRecord } from "../../core/safe-error";
import {
  ConnectionController,
  type ConnectionControllerHost,
  type ConnectionRepositoryService,
  type DiscoveredRepository,
} from "../../src/connection-controller";
import { createDefaultData } from "../../src/defaults";
import type { S3SyncData, S3SyncSettings } from "../../src/types";

const repository: DiscoveredRepository = {
  key: "team/.obsidian-s3-sync/v1/repositories/repository.json",
  repositoryId: "123e4567-e89b-42d3-a456-426614174000",
  descriptorHash: "a".repeat(64),
  configDir: ".obsidian",
  historicalConfigDirs: [],
};

function settings(overrides: Partial<S3SyncSettings> = {}): S3SyncSettings {
  return {
    endpoint: "https://s3.example.com",
    region: "test",
    bucket: "vault",
    prefix: "team",
    forcePathStyle: true,
    accessKeyId: "id",
    secretAccessKey: "secret",
    autoSync: false,
    ignoredPatterns: ".trash/**",
    configProfile: createDefaultConfigProfile("1.8.0"),
    ...overrides,
  };
}

function service(repositories: DiscoveredRepository[], events: string[]): ConnectionRepositoryService {
  return {
    discover: vi.fn(async () => { events.push("discover"); return repositories; }),
    createRepository: vi.fn(async () => {
      events.push("create");
      return { key: repository.key, repositoryId: repository.repositoryId, descriptorHash: repository.descriptorHash };
    }),
    assertDescriptorBinding: vi.fn(async () => { events.push("descriptor"); }),
    verifyFrontierAnchor: vi.fn(async () => { events.push("frontier"); }),
    probeWritableConnection: vi.fn(async () => { events.push("probe"); }),
  };
}

function harness(input: {
  initialSettings?: S3SyncSettings;
  initialData?: S3SyncData;
  repositories?: DiscoveredRepository[];
  activateError?: unknown;
  configDir?: string;
}) {
  let currentSettings = structuredClone(input.initialSettings ?? settings());
  let currentData = structuredClone(input.initialData ?? createDefaultData());
  const events: string[] = [];
  const remote = service(input.repositories ?? [repository], events);
  const host: ConnectionControllerHost = {
    configDir: input.configDir ?? ".obsidian",
    vaultName: "Vault",
    getSettings: () => currentSettings,
    setSettings: (value) => { currentSettings = value; events.push("set-settings"); },
    getData: () => currentData,
    setData: (value) => { currentData = value; events.push("set-data"); },
    createService: () => remote,
    stopAndFlush: vi.fn(async () => { events.push("stop-and-flush"); }),
    persistRepositoryState: vi.fn(async () => { events.push("persist-old-state"); }),
    clearRepositoryState: vi.fn(() => { events.push("clear-state"); }),
    createUnboundData: () => createDefaultData(),
    activateRepository: vi.fn(async (locator, selected) => {
      events.push("activate");
      if (input.activateError) throw input.activateError;
      currentData.v1 = {
        ...createPersistedRepositoryBinding(
          locator,
          selected.repositoryId,
          selected.descriptorHash,
          selected.configDir,
          selected.historicalConfigDirs,
        ),
        writerFrontiers: {},
        writerId: "123e4567-e89b-42d3-a456-426614174001",
        nextSequence: "00000000000000000001",
        previousCommitHash: null,
      };
    }),
    savePluginData: vi.fn(async () => { events.push("save"); }),
    markRepositoryVerified: vi.fn(() => { events.push("verified"); }),
  };
  return {
    controller: new ConnectionController(host),
    events,
    host,
    remote,
    settings: () => currentSettings,
    data: () => currentData,
  };
}

function boundData(boundSettings = settings()): S3SyncData {
  const data = createDefaultData();
  const locator = createRepositoryLocator({ ...boundSettings, prefix: boundSettings.prefix });
  data.v1 = {
    ...createPersistedRepositoryBinding(
      locator,
      repository.repositoryId,
      repository.descriptorHash,
      repository.configDir,
      repository.historicalConfigDirs,
    ),
    writerFrontiers: {},
    writerId: "123e4567-e89b-42d3-a456-426614174001",
    nextSequence: "00000000000000000001",
    previousCommitHash: null,
  };
  return data;
}

describe("connection controller", () => {
  it("probes first and automatically creates and activates an empty repository scope", async () => {
    const test = harness({ repositories: [] });

    await expect(test.controller.testAndApply(settings())).resolves.toBe("连接成功；已自动创建并接入仓库。");

    expect(test.events.slice(0, 4)).toEqual(["discover", "probe", "create", "set-settings"]);
    expect(test.events).toContain("activate");
    expect(test.data().v1?.repositoryId).toBe(repository.repositoryId);
  });

  it("verifies the selected repository before applying a route-only change", async () => {
    const original = settings();
    const test = harness({ initialSettings: original, initialData: boundData(original) });

    await expect(test.controller.testAndApply({ ...original, endpoint: "https://route.example.com" }))
      .resolves.toBe("连接成功并已验证当前仓库。");

    expect(test.events).toEqual([
      "discover", "descriptor", "probe", "stop-and-flush", "set-settings", "set-data", "verified", "save",
    ]);
    expect(test.settings().endpoint).toBe("https://route.example.com");
    expect(test.data().v1?.locator.endpoint).toBe("https://route.example.com");
  });

  it("persists the old repository before switching scope and disables automatic sync", async () => {
    const original = settings({ autoSync: true });
    const candidate = { ...original, bucket: "other-vault" };
    const test = harness({ initialSettings: original, initialData: boundData(original) });

    await test.controller.testAndApply(candidate);

    expect(test.events.indexOf("persist-old-state")).toBeLessThan(test.events.indexOf("activate"));
    expect(test.settings().bucket).toBe("other-vault");
    expect(test.settings().autoSync).toBe(false);
  });

  it("allows a changed config directory to move to a new Prefix but not to reuse the old repository", async () => {
    const original = settings();
    const selected = boundData(original);
    const sameScope = harness({ initialSettings: original, initialData: selected, configDir: "settings" });

    const blocked = await sameScope.controller.testAndApply(original).catch((cause) => cause);
    expect(safeErrorRecord(blocked)).toMatchObject({
      category: "repository-identity",
      reasonCode: "CONNECTION_LOCAL_DIRECTORY_BINDING_CHANGED",
      connectionStage: "repository-verification",
    });

    const switched = harness({
      initialSettings: original,
      initialData: selected,
      configDir: "settings",
      repositories: [],
    });
    await expect(switched.controller.testAndApply({ ...original, prefix: "new-team" }))
      .resolves.toBe("连接成功；已自动创建并接入仓库。");
    expect(switched.settings().prefix).toBe("new-team");
    expect(switched.remote.createRepository).toHaveBeenCalledWith(expect.any(String), "settings", [".obsidian"]);
  });

  it("rejects a discovered repository bound to a different config directory", async () => {
    const test = harness({ repositories: [{ ...repository, configDir: "settings" }] });

    const error = await test.controller.testAndApply(settings()).catch((cause) => cause);

    expect(safeErrorRecord(error)).toMatchObject({
      category: "repository-identity",
      reasonCode: "CONNECTION_REMOTE_DIRECTORY_BINDING_MISMATCH",
      connectionStage: "repository-discovery",
    });
    expect(test.events).toEqual(["discover"]);
  });

  it("rejects ambiguous repository scopes without probing or mutating local settings", async () => {
    const duplicate = { ...repository, repositoryId: "123e4567-e89b-42d3-a456-426614174099", descriptorHash: "b".repeat(64) };
    const test = harness({ repositories: [repository, duplicate] });

    const error = await test.controller.testAndApply(settings()).catch((cause) => cause);

    expect(safeErrorRecord(error)).toMatchObject({
      category: "repository-identity",
      reasonCode: "CONNECTION_REPOSITORY_SCOPE_AMBIGUOUS",
      connectionStage: "repository-discovery",
    });
    expect(test.events).toEqual(["discover"]);
  });

  it("restores and persists the previous local configuration when repository activation fails", async () => {
    const original = settings();
    const originalData = createDefaultData();
    const test = harness({
      initialSettings: original,
      initialData: originalData,
      activateError: new Error("injected activation failure"),
    });

    const error = await test.controller.testAndApply(settings({ bucket: "other-vault" })).catch((cause) => cause);

    expect(safeErrorRecord(error).connectionStage).toBe("repository-bind");
    expect(test.settings()).toEqual(original);
    expect(test.data()).toEqual(originalData);
    expect(test.events.slice(-4)).toEqual(["set-settings", "set-data", "clear-state", "save"]);
  });
});
