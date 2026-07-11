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
    if (byId.has(version.versionId)) invalid.add(version.versionId);
    else byId.set(version.versionId, version);
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
  for (const version of byId.values()) {
    if (!verified.has(version.versionId) && version.parents.every((parent) => byId.has(parent))) invalid.add(version.versionId);
  }
  const superseded = new Set<string>();
  for (const versionId of verified) for (const parent of byId.get(versionId)!.parents) superseded.add(parent);
  return {
    heads: [...verified].filter((id) => !superseded.has(id)).sort(),
    pending: [...byId.keys()].filter((id) => !verified.has(id) && !invalid.has(id)).sort(),
    invalid: [...invalid].sort(),
  };
}
