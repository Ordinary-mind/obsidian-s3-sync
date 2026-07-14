import { assessReservedRoot, createReservedRootMetadata, encodeReservedRootMetadata } from "./reserved-root";
import { LOCAL_STATE_CONTAINER, localStateRoot } from "./scope";
import type { DurableStateFileAdapter } from "./durable-state";
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
    const metadata = await adapter.exists(metadataPath)
      ? new TextEncoder().encode(await adapter.read(metadataPath))
      : undefined;
    const assessment = assessReservedRoot({ type: "directory", metadata }, expected);
    if (assessment.decision === "use") ownedRepositoryIds.push(repositoryId);
    else refusedRoots.push(folder);
  }
  return {
    ownedRepositoryIds: [...new Set(ownedRepositoryIds)].sort(),
    refusedRoots: [...new Set(refusedRoots)].sort(),
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
  const metadata = await adapter.exists(metadataPath) ? new TextEncoder().encode(await adapter.read(metadataPath)) : undefined;
  const assessment = assessReservedRoot({ type: "directory", metadata }, createReservedRootMetadata("repository-state", repositoryId));
  if (assessment.decision !== "use") {
    const reason = assessment.decision === "refuse" ? assessment.reason : "unexpected-create";
    throw new Error(`repository state root ownership refused: ${reason}`);
  }
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
