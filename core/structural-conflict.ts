export interface StructuralHead {
  path: string;
  versionId: string;
}

export interface StructuralConflict {
  paths: string[];
  heads: string[];
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
