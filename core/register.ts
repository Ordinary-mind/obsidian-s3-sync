export interface RegisterVersion {
  versionId: string;
  logicalKey: string;
  parents: string[];
}

export interface RegisterState {
  heads: string[];
  pending: string[];
  invalid: string[];
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
      if (parent && parent.logicalKey !== version.logicalKey) invalid.add(version.versionId);
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

function sameVersion(left: RegisterVersion, right: RegisterVersion): boolean {
  return left.logicalKey === right.logicalKey && left.parents.length === right.parents.length && left.parents.every((parent, index) => parent === right.parents[index]);
}
