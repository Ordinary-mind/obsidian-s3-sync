import { assessReservedRoot, createReservedRootMetadata, encodeReservedRootMetadata } from "./reserved-root";
import { LOCAL_STATE_CONTAINER, localStateRoot } from "./scope";
import { DurableStateStore, type DurableStateFileAdapter, type StateJsonValue } from "./durable-state";
import { parseRepositoryDurablePayload } from "./repository-durable-payload";
import { normalizeVaultPath } from "./path";
import {
  REPOSITORY_STATE_AREAS,
  repositoryStateLayout,
  resolveRepositoryStateReference,
  type RepositoryStateArea,
  type RepositoryStateLayout,
} from "./local-state-layout";

const ownerFile = "owner.json";

export interface LocalStatePathAdapter {
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ type: "file" | "folder" } | null>;
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string>;
  write(path: string, source: string): Promise<void>;
  list?(path: string): Promise<{ files: string[]; folders: string[] }>;
}

export interface RepositoryStateFiles extends DurableStateFileAdapter {
  readonly layout: RepositoryStateLayout;
  resolve(reference: string, allowedAreas?: readonly RepositoryStateArea[]): string;
}

export interface ResidualRepositoryStateScan {
  ownedRepositoryIds: string[];
  refusedRoots: string[];
}

export type ResidualRepositoryStateIssueReason =
  | "root-refused"
  | "scan-failed"
  | "state-missing"
  | "state-invalid"
  | "repository-mismatch";

export interface ResidualRepositoryStateIssue {
  root: string;
  reason: ResidualRepositoryStateIssueReason;
}

export interface RecoveredRepositoryDirectories {
  repositoryId: string;
  root: string;
  configDir: string;
  historicalConfigDirs: string[];
}

export interface ResidualRepositoryDirectoryRecovery {
  complete: boolean;
  recovered: RecoveredRepositoryDirectories[];
  historicalConfigDirCandidates: string[];
  issues: ResidualRepositoryStateIssue[];
}

export async function openRepositoryStateFiles(
  adapter: LocalStatePathAdapter,
  configDir: string,
  repositoryId: string,
): Promise<RepositoryStateFiles> {
  const root = localStateRoot(configDir, repositoryId);
  const layout = repositoryStateLayout(configDir, repositoryId);
  const container = `${configDir.replace(/\/+$/, "")}/${LOCAL_STATE_CONTAINER}`;
  await ensureDirectory(adapter, container);
  if (!(await adapter.exists(root))) {
    await adapter.mkdir(root);
    await adapter.write(`${root}/${ownerFile}`, new TextDecoder().decode(encodeReservedRootMetadata(createReservedRootMetadata("repository-state", repositoryId))));
  }
  await assertOwnedRoot(adapter, root, repositoryId);
  for (const area of REPOSITORY_STATE_AREAS) await ensureDirectory(adapter, `${root}/${area}`);
  return {
    layout,
    resolve: (reference, allowedAreas) => resolveRepositoryStateReference(layout, reference, allowedAreas),
    read: async (name) => {
      await assertOwnedRoot(adapter, root, repositoryId);
      const path = `${root}/${name}`;
      if (!(await adapter.exists(path))) return undefined;
      if ((await adapter.stat(path))?.type !== "file") throw new Error("durable state copy is not a regular file");
      return adapter.read(path);
    },
    write: async (name, source) => {
      await assertOwnedRoot(adapter, root, repositoryId);
      await adapter.write(`${root}/${name}`, source);
    },
  };
}

export async function scanResidualRepositoryStateRoots(
  adapter: LocalStatePathAdapter,
  configDir: string,
): Promise<ResidualRepositoryStateScan> {
  const container = `${configDir.replace(/\/+$/, "")}/${LOCAL_STATE_CONTAINER}`;
  if (!(await adapter.exists(container))) return { ownedRepositoryIds: [], refusedRoots: [] };
  if ((await adapter.stat(container))?.type !== "folder") return { ownedRepositoryIds: [], refusedRoots: [container] };
  if (!adapter.list) throw new Error("local state adapter cannot enumerate residual repository roots");

  const listed = await adapter.list(container);
  const ownedRepositoryIds: string[] = [];
  const refusedRoots: string[] = listed.files
    .map((path) => normalizeListedPath(path, container))
    .filter((path) => parentPath(path) === container);
  for (const folder of listed.folders.map((path) => normalizeListedPath(path, container)).filter((path) => parentPath(path) === container).sort()) {
    const repositoryId = baseName(folder);
    let expected;
    try {
      expected = createReservedRootMetadata("repository-state", repositoryId);
    } catch {
      refusedRoots.push(folder);
      continue;
    }
    const metadataPath = `${folder}/${ownerFile}`;
    const metadata = await readMetadata(adapter, metadataPath);
    const assessment = assessReservedRoot({ type: "directory", metadata }, expected);
    if (assessment.decision === "use") ownedRepositoryIds.push(repositoryId);
    else refusedRoots.push(folder);
  }
  return {
    ownedRepositoryIds: [...new Set(ownedRepositoryIds)].sort(),
    refusedRoots: [...new Set(refusedRoots)].sort(),
  };
}

export async function recoverResidualRepositoryDirectories(
  adapter: LocalStatePathAdapter,
  configDir: string,
): Promise<ResidualRepositoryDirectoryRecovery> {
  const normalizedConfigDir = normalizeVaultPath(configDir);
  const container = `${normalizedConfigDir}/${LOCAL_STATE_CONTAINER}`;
  let scan: ResidualRepositoryStateScan;
  try {
    scan = await scanResidualRepositoryStateRoots(adapter, normalizedConfigDir);
  } catch {
    return {
      complete: false,
      recovered: [],
      historicalConfigDirCandidates: [],
      issues: [{ root: container, reason: "scan-failed" }],
    };
  }

  const issues: ResidualRepositoryStateIssue[] = scan.refusedRoots.map((root) => ({ root, reason: "root-refused" }));
  const recovered: RecoveredRepositoryDirectories[] = [];
  for (const repositoryId of scan.ownedRepositoryIds) {
    const root = localStateRoot(normalizedConfigDir, repositoryId);
    try {
      const store = new DurableStateStore<StateJsonValue>({
        read: (name) => readStateCopy(adapter, root, name),
        write: async () => { throw new Error("residual repository recovery is read-only"); },
      });
      const snapshot = await store.load();
      if (!snapshot) {
        issues.push({ root, reason: "state-missing" });
        continue;
      }
      const payload = parseRepositoryDurablePayload(snapshot.payload);
      if (payload.repositoryId !== repositoryId) {
        issues.push({ root, reason: "repository-mismatch" });
        continue;
      }
      recovered.push({
        repositoryId,
        root,
        configDir: normalizeVaultPath(payload.configDir),
        historicalConfigDirs: payload.historicalConfigDirs.map(normalizeVaultPath),
      });
    } catch {
      issues.push({ root, reason: "state-invalid" });
    }
  }

  const candidates = new Set<string>();
  for (const entry of recovered) {
    candidates.add(entry.configDir);
    for (const historical of entry.historicalConfigDirs) candidates.add(historical);
  }
  return {
    complete: issues.length === 0,
    recovered: recovered.sort((left, right) => left.repositoryId.localeCompare(right.repositoryId)),
    historicalConfigDirCandidates: [...candidates].sort(compareUtf8),
    issues: issues.sort((left, right) => left.root.localeCompare(right.root) || left.reason.localeCompare(right.reason)),
  };
}

async function ensureDirectory(adapter: LocalStatePathAdapter, path: string): Promise<void> {
  if (!(await adapter.exists(path))) await adapter.mkdir(path);
  if ((await adapter.stat(path))?.type !== "folder") throw new Error("local state container is not a directory");
}

async function assertOwnedRoot(adapter: LocalStatePathAdapter, root: string, repositoryId: string): Promise<void> {
  const stat = await adapter.stat(root);
  if (stat?.type !== "folder") throw new Error("repository state root is not a directory");
  const metadataPath = `${root}/${ownerFile}`;
  const metadata = await readMetadata(adapter, metadataPath);
  const assessment = assessReservedRoot({ type: "directory", metadata }, createReservedRootMetadata("repository-state", repositoryId));
  if (assessment.decision !== "use") {
    const reason = assessment.decision === "refuse" ? assessment.reason : "unexpected-create";
    throw new Error(`repository state root ownership refused: ${reason}`);
  }
}

async function readMetadata(adapter: LocalStatePathAdapter, path: string): Promise<Uint8Array | undefined> {
  if (!(await adapter.exists(path)) || (await adapter.stat(path))?.type !== "file") return undefined;
  return new TextEncoder().encode(await adapter.read(path));
}

async function readStateCopy(
  adapter: LocalStatePathAdapter,
  root: string,
  name: "state-a.json" | "state-b.json",
): Promise<string | undefined> {
  const path = `${root}/${name}`;
  if (!(await adapter.exists(path))) return undefined;
  if ((await adapter.stat(path))?.type !== "file") throw new Error("durable state copy is not a regular file");
  return adapter.read(path);
}

function normalizeListedPath(path: string, container: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.includes("/") ? normalized : `${container}/${normalized}`;
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}
