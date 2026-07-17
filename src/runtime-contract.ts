import { compareUtf8, validateChangeChunkObject } from "../protocol/semantics";
import { defaultCaseFold151 } from "../protocol/unicode";
import { DiagnosticError } from "../core/diagnostics";

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
  configDirAvailable: boolean;
  durableWriteReadback: boolean;
  durableAcrossPluginReload: boolean | null;
  editorChangeObserved: boolean;
  writeReadback: boolean;
  rename: boolean;
  renameRejectsExistingTarget: boolean;
  renameNoClobberPreservesBytes: boolean;
  copyRejectsExistingTarget: boolean;
  unicodeCaseFold151: boolean;
  utf8Ordering: boolean;
  pathPrefixConflict: boolean;
}

export async function runDesktopRuntimeContract(
  adapter: RuntimeContractAdapter,
  configDir: string,
  pluginId: string,
  sessionId: string,
  editorChangeObserved: boolean,
  runId = Date.now().toString(36),
): Promise<DesktopRuntimeContractResult> {
  if (!configDir) {
    throw new DiagnosticError(
      "RUNTIME_CONTRACT_CONFIG_DIR_MISSING",
      "local-path",
      "Vault configDir is empty",
    );
  }

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
      configDirAvailable: true,
      durableWriteReadback,
      durableAcrossPluginReload,
      editorChangeObserved,
      writeReadback,
      rename,
      renameRejectsExistingTarget,
      renameNoClobberPreservesBytes,
      copyRejectsExistingTarget,
      unicodeCaseFold151: defaultCaseFold151("Straße/Note.md") === defaultCaseFold151("STRASSE/note.md"),
      utf8Ordering: ["😀", "é", "z", "Å", "a"].sort(compareUtf8).join("\u0000") === ["a", "z", "Å", "é", "😀"].join("\u0000"),
      pathPrefixConflict: validateChangeChunkObject({
        protocol: 1,
        repositoryId: "123e4567-e89b-42d3-a456-426614174000",
        descriptorHash: "a".repeat(64),
        channel: "vault",
        chunkIndex: 0,
        chunkCount: 1,
        mutations: ["Notes/Active", "notes/active/child.md"].map((path, index) => ({
          path,
          kind: "put" as const,
          blobHash: String(index + 1).repeat(64),
          size: 1,
          parents: [],
        })),
      }).includes("vault-put-path-prefix-conflict"),
    };
  } finally {
    if (await adapter.exists(root)) await adapter.rmdir(root, true);
  }
}
