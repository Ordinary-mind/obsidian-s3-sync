export interface RegisterVersion {
  versionId: string;
  repositoryId: string;
  channel: "vault" | "config";
  logicalKey: string;
  parents: string[];
}

export interface RegisterState {
  heads: string[];
  pending: string[];
  invalid: string[];
}

export interface SemanticHeadGroup {
  value: string;
  representative: string;
  members: string[];
}

export function reduceRegister(versions: readonly RegisterVersion[]): RegisterState {
  const byId = new Map<string, RegisterVersion>();
  const invalid = new Set<string>();
  for (const version of versions) {
    const existing = byId.get(version.versionId);
    if (!existing) {
      byId.set(version.versionId, version);
    } else if (!sameVersion(existing, version)) {
      invalid.add(version.versionId);
    }
  }
  for (const version of byId.values()) {
    if (version.parents.includes(version.versionId)) invalid.add(version.versionId);
    for (const parentId of version.parents) {
      const parent = byId.get(parentId);
      if (parent && (parent.repositoryId !== version.repositoryId || parent.channel !== version.channel || parent.logicalKey !== version.logicalKey)) invalid.add(version.versionId);
    }
  }
  const verified = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const version of byId.values()) {
      if (!invalid.has(version.versionId) && !verified.has(version.versionId) && version.parents.every((parent) => verified.has(parent))) {
        verified.add(version.versionId);
        changed = true;
      }
    }
  }
  const reachesMissingParent = (versionId: string, visiting = new Set<string>()): boolean => {
    if (visiting.has(versionId)) return false;
    visiting.add(versionId);
    const version = byId.get(versionId)!;
    return version.parents.some((parent) => !byId.has(parent) || reachesMissingParent(parent, visiting));
  };
  for (const version of byId.values()) {
    if (!verified.has(version.versionId) && !invalid.has(version.versionId) && !reachesMissingParent(version.versionId)) {
      invalid.add(version.versionId);
    }
  }
  const superseded = new Set<string>();
  for (const versionId of verified) for (const parent of byId.get(versionId)!.parents) superseded.add(parent);
  return {
    heads: [...verified].filter((id) => !superseded.has(id)).sort(),
    pending: [...byId.keys()].filter((id) => !verified.has(id) && !invalid.has(id)).sort(),
    invalid: [...invalid].sort(),
  };
}

export function groupEquivalentHeads(heads: readonly string[], values: ReadonlyMap<string, string>): SemanticHeadGroup[] {
  const groups = new Map<string, string[]>();
  for (const head of heads) {
    const value = values.get(head);
    if (value === undefined) throw new Error(`missing semantic value for head: ${head}`);
    const members = groups.get(value) ?? [];
    members.push(head);
    groups.set(value, members);
  }
  return [...groups.entries()]
    .map(([value, members]) => ({ value, members: [...members].sort(), representative: [...members].sort()[0] }))
    .sort((left, right) => (left.value < right.value ? -1 : left.value > right.value ? 1 : 0));
}

function sameVersion(left: RegisterVersion, right: RegisterVersion): boolean {
  return left.repositoryId === right.repositoryId && left.channel === right.channel && left.logicalKey === right.logicalKey && left.parents.length === right.parents.length && left.parents.every((parent, index) => parent === right.parents[index]);
}
