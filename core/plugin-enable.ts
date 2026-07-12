export function mergeEnabledPortablePlugins(remotePortable: readonly string[], localUnmanaged: readonly string[], syncPluginId: string): string[] {
  return [...new Set([...remotePortable, ...localUnmanaged, syncPluginId])].sort();
}
