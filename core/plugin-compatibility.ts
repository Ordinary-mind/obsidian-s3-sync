export interface PluginManifestInfo {
  id: string;
  version: string;
  minAppVersion?: string;
  isDesktopOnly?: boolean;
}

export function isPortablePluginCompatible(manifest: PluginManifestInfo, expectedId: string, targetAppVersion: string, isDesktop: boolean): boolean {
  if (manifest.id !== expectedId || manifest.isDesktopOnly === true && !isDesktop) return false;
  if (!isPlainSemver(manifest.version) || !isPlainSemver(targetAppVersion)) return false;
  return manifest.minAppVersion === undefined || (isPlainSemver(manifest.minAppVersion) && comparePlainVersion(manifest.minAppVersion, targetAppVersion) <= 0);
}

function isPlainSemver(value: string): boolean { return /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value); }
export function comparePlainVersion(left: string, right: string): number {
  if (!isPlainSemver(left) || !isPlainSemver(right)) throw new Error("version must have three canonical decimal components");
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index].length !== rightParts[index].length) return leftParts[index].length < rightParts[index].length ? -1 : 1;
    if (leftParts[index] !== rightParts[index]) return leftParts[index] < rightParts[index] ? -1 : 1;
  }
  return 0;
}
