import { parseBoundedJson } from "../protocol/json";
import { validatePortablePluginId } from "./path";
import type { PluginManifestInfo } from "./plugin-compatibility";

const manifestMaximumBytes = 256 * 1024;

export function parsePluginManifest(bytes: Uint8Array): PluginManifestInfo {
  const value = parseBoundedJson(bytes, manifestMaximumBytes, "object") as Record<string, unknown>;
  if (typeof value.id !== "string" || typeof value.version !== "string") throw new Error("plugin manifest requires string id and version");
  if (validatePortablePluginId(value.id).length > 0) throw new Error("plugin manifest id is invalid");
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value.version)) throw new Error("plugin manifest version is invalid");
  if (value.minAppVersion !== undefined && (typeof value.minAppVersion !== "string"
    || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value.minAppVersion))) {
    throw new Error("plugin manifest minAppVersion is invalid");
  }
  if (value.isDesktopOnly !== undefined && typeof value.isDesktopOnly !== "boolean") throw new Error("plugin manifest isDesktopOnly is invalid");
  return {
    id: value.id,
    version: value.version,
    ...(value.minAppVersion !== undefined ? { minAppVersion: value.minAppVersion as string } : {}),
    ...(value.isDesktopOnly !== undefined ? { isDesktopOnly: value.isDesktopOnly as boolean } : {}),
  };
}
