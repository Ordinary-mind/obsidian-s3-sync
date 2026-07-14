import { conflictId, conflictLogicalKey } from "./conflict-id";
import { validateRemoteVaultPath } from "./path";

export interface StructuralHead {
  path: string;
  versionId: string;
}

export interface StructuralConflict {
  paths: string[];
  heads: string[];
}

export function findCaseAliasConflicts(heads: readonly StructuralHead[], caseFold: (path: string) => string): StructuralConflict[] {
  const groups = new Map<string, StructuralHead[]>();
  for (const head of heads) {
    const path = validateRemoteVaultPath(head.path);
    const key = caseFold(path);
    const group = groups.get(key) ?? [];
    group.push({ path, versionId: head.versionId });
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => new Set(group.map((head) => head.path)).size > 1)
    .map((group) => ({ paths: sortUnique(group.map((head) => head.path)), heads: sortUnique(group.map((head) => head.versionId)) }))
    .sort((left, right) => compareUtf8(left.paths[0], right.paths[0]));
}

export function findStructuralConflicts(heads: readonly StructuralHead[]): StructuralConflict[] {
  const normalized = heads.map((head) => ({ path: validateRemoteVaultPath(head.path), versionId: head.versionId }));
  const paths = sortUnique(normalized.map((head) => head.path));
  const parent = paths.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  const pathIndexes = new Map(paths.map((path, index) => [path, index]));
  for (let index = 0; index < paths.length; index += 1) {
    const segments = paths[index].split("/");
    for (let length = 1; length < segments.length; length += 1) {
      const ancestor = pathIndexes.get(segments.slice(0, length).join("/"));
      if (ancestor !== undefined) union(ancestor, index);
    }
  }
  const components = new Map<number, string[]>();
  for (let index = 0; index < paths.length; index += 1) {
    const root = find(index);
    const component = components.get(root) ?? [];
    component.push(paths[index]);
    components.set(root, component);
  }
  return [...components.values()]
    .filter((component) => component.length > 1)
    .map((component) => {
      const componentPaths = sortUnique(component);
      const pathSet = new Set(componentPaths);
      return {
        paths: componentPaths,
        heads: sortUnique(normalized.filter((head) => pathSet.has(head.path)).map((head) => head.versionId)),
      };
    })
    .sort((left, right) => compareUtf8(left.paths[0], right.paths[0]));
}

export function structuralConflictId(repositoryId: string, conflict: StructuralConflict): string {
  return conflictId(repositoryId, "vault", conflict.paths.map((path) => conflictLogicalKey("vault", path)), conflict.heads);
}

export function structuralConflictBlocksPath(conflict: StructuralConflict, path: string): boolean {
  const normalized = validateRemoteVaultPath(path);
  return conflict.paths.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function sortUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareUtf8);
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
