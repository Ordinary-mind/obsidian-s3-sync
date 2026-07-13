import { assessReservedRoot, createReservedRootMetadata, encodeReservedRootMetadata } from "./reserved-root";
import { LOCAL_STATE_CONTAINER, localStateRoot } from "./scope";
import type { DurableStateFileAdapter } from "./durable-state";

const ownerFile = "owner.json";

export interface LocalStatePathAdapter {
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ type: "file" | "folder" } | null>;
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string>;
  write(path: string, source: string): Promise<void>;
}

export async function openRepositoryStateFiles(
  adapter: LocalStatePathAdapter,
  configDir: string,
  repositoryId: string,
): Promise<DurableStateFileAdapter> {
  const root = localStateRoot(configDir, repositoryId);
  const container = `${configDir.replace(/\/+$/, "")}/${LOCAL_STATE_CONTAINER}`;
  await ensureDirectory(adapter, container);
  if (!(await adapter.exists(root))) {
    await adapter.mkdir(root);
    await adapter.write(`${root}/${ownerFile}`, new TextDecoder().decode(encodeReservedRootMetadata(createReservedRootMetadata("repository-state", repositoryId))));
  }
  await assertOwnedRoot(adapter, root, repositoryId);
  return {
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
