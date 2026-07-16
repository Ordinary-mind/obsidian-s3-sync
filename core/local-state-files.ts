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
  rename?(path: string, newPath: string): Promise<void>;
}

export interface RepositoryStateFiles extends DurableStateFileAdapter {
  readonly layout: RepositoryStateLayout;
  resolve(reference: string, allowedAreas?: readonly RepositoryStateArea[]): string;
}

export interface ArchivedRepositoryStateCopies {
  archived: string[];
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

export async function archiveRepositoryStateCopies(
  adapter: LocalStatePathAdapter,
  configDir: string,
  repositoryId: string,
  archiveId: string,
): Promise<ArchivedRepositoryStateCopies> {
  if (!adapter.rename) throw new Error("local state adapter cannot archive invalid state copies");
  if (!/^[A-Za-z0-9._-]{1,96}$/.test(archiveId)) throw new Error("invalid local state archive id");
  const files = await openRepositoryStateFiles(adapter, configDir, repositoryId);
  const archived: string[] = [];
  for (const name of ["state-a.json", "state-b.json"] as const) {
    const source = `${files.layout.root}/${name}`;
    if (!(await adapter.exists(source))) continue;
    if ((await adapter.stat(source))?.type !== "file") throw new Error("durable state copy is not a regular file");
    const target = `${files.layout.recovery}/${archiveId}-${name}`;
    if (await adapter.exists(target)) throw new Error("local state archive target already exists");
    await adapter.rename(source, target);
    archived.push(target);
  }
  if (archived.length === 0) throw new Error("no local state copies were available to archive");
  return { archived };
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
