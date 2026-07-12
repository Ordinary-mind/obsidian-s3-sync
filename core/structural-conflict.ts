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
    const group = groups.get(caseFold(head.path)) ?? [];
    group.push(head);
    groups.set(caseFold(head.path), group);
  }
  return [...groups.values()]
    .filter((group) => new Set(group.map((head) => head.path)).size > 1)
    .map((group) => ({ paths: group.map((head) => head.path).sort(), heads: group.map((head) => head.versionId).sort() }));
}

export function findStructuralConflicts(heads: readonly StructuralHead[]): StructuralConflict[] {
  const conflicts: StructuralConflict[] = [];
  const sorted = [...heads].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  for (let index = 0; index < sorted.length; index += 1) {
    for (let next = index + 1; next < sorted.length; next += 1) {
      if (!sorted[next].path.startsWith(`${sorted[index].path}/`)) break;
      conflicts.push({ paths: [sorted[index].path, sorted[next].path], heads: [sorted[index].versionId, sorted[next].versionId].sort() });
    }
  }
  return conflicts;
}
