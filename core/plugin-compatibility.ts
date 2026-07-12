export interface PluginManifestInfo {
  id: string;
  version: string;
  minAppVersion?: string;
  isDesktopOnly?: boolean;
}

export function isPortablePluginCompatible(manifest: PluginManifestInfo, expectedId: string, targetAppVersion: string, isDesktop: boolean): boolean {
  if (manifest.id !== expectedId || manifest.isDesktopOnly === true && !isDesktop) return false;
  if (!isPlainSemver(manifest.version) || !isPlainSemver(targetAppVersion)) return false;
  return manifest.minAppVersion === undefined || (isPlainSemver(manifest.minAppVersion) && compareSemver(manifest.minAppVersion, targetAppVersion) <= 0);
}

function isPlainSemver(value: string): boolean { return /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value); }
function compareSemver(left: string, right: string): number {
  const a = left.split(".").map(Number); const b = right.split(".").map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
