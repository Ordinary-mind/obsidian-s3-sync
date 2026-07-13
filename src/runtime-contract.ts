export interface RuntimeContractAdapter {
  copy(path: string, target: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string>;
  rename(path: string, target: string): Promise<void>;
  rmdir(path: string, recursive: boolean): Promise<void>;
  write(path: string, data: string): Promise<void>;
}

export interface DesktopRuntimeContractResult {
  configDir: string;
  durableWriteReadback: boolean;
  durableAcrossPluginReload: boolean | null;
  editorChangeObserved: boolean;
  writeReadback: boolean;
  rename: boolean;
  renameRejectsExistingTarget: boolean;
  renameNoClobberPreservesBytes: boolean;
  copyRejectsExistingTarget: boolean;
}

export async function runDesktopRuntimeContract(
  adapter: RuntimeContractAdapter,
  configDir: string,
  pluginId: string,
  sessionId: string,
  editorChangeObserved: boolean,
  runId = Date.now().toString(36),
): Promise<DesktopRuntimeContractResult> {
  if (!configDir) throw new Error("Vault configDir is empty");

  const root = `${configDir.replace(/\/+$/, "")}/plugins/${pluginId}/runtime-contract-${runId}`;
  const source = `${root}/source.txt`;
  const renamed = `${root}/renamed.txt`;
  const existing = `${root}/existing.txt`;
  const durableMarker = `${configDir.replace(/\/+$/, "")}/plugins/${pluginId}/runtime-contract-durable.json`;
  const body = `runtime-contract:${runId}`;

  try {
    let durableAcrossPluginReload: boolean | null = null;
    if (await adapter.exists(durableMarker)) {
      const previous = JSON.parse(await adapter.read(durableMarker)) as { sessionId?: unknown };
      durableAcrossPluginReload = typeof previous.sessionId === "string" && previous.sessionId !== sessionId;
    }
    await adapter.write(durableMarker, JSON.stringify({ sessionId }));
    const durableWriteReadback = (JSON.parse(await adapter.read(durableMarker)) as { sessionId?: unknown }).sessionId === sessionId;

    await adapter.mkdir(root);
    await adapter.write(source, body);
    const writeReadback = await adapter.read(source) === body;

    await adapter.rename(source, renamed);
    const rename = await adapter.exists(renamed) && await adapter.read(renamed) === body;

    await adapter.write(existing, "existing");
    let renameRejectsExistingTarget = false;
    try {
      await adapter.rename(renamed, existing);
    } catch {
      renameRejectsExistingTarget = true;
    }

    const renameNoClobberPreservesBytes = renameRejectsExistingTarget
      && await adapter.read(renamed) === body
      && await adapter.read(existing) === "existing";

    if (!renameNoClobberPreservesBytes) {
      await adapter.write(renamed, body);
      await adapter.write(existing, "existing");
    }

    let copyRejectsExistingTarget = false;
    try {
      await adapter.copy(renamed, existing);
    } catch {
      copyRejectsExistingTarget = true;
    }

    return {
      configDir,
      durableWriteReadback,
      durableAcrossPluginReload,
      editorChangeObserved,
      writeReadback,
      rename,
      renameRejectsExistingTarget,
      renameNoClobberPreservesBytes,
      copyRejectsExistingTarget,
    };
  } finally {
    if (await adapter.exists(root)) await adapter.rmdir(root, true);
  }
}
