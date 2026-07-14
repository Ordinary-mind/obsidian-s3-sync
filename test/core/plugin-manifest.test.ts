import { describe, expect, it } from "vitest";
import { parsePluginManifest } from "../../core/plugin-manifest";
import { comparePlainVersion, isPortablePluginCompatible } from "../../core/plugin-compatibility";

describe("bounded plugin manifest", () => {
  it("accepts unknown fields while validating known compatibility fields", () => {
    const manifest = parsePluginManifest(bytes('{"id":"plugin","version":"1.2.3","minAppVersion":"1.8.0","isDesktopOnly":false,"future":{"x":1}}'));
    expect(manifest).toEqual({ id: "plugin", version: "1.2.3", minAppVersion: "1.8.0", isDesktopOnly: false });
  });

  it("rejects BOM, duplicate keys, wrong known types, excessive depth and body size", () => {
    expect(() => parsePluginManifest(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('{"id":"p","version":"1.0.0"}')]))) .toThrow();
    expect(() => parsePluginManifest(bytes('{"id":"p","id":"q","version":"1.0.0"}'))).toThrow("duplicate");
    expect(() => parsePluginManifest(bytes('{"id":"p","version":"1.0.0","isDesktopOnly":"yes"}'))).toThrow("isDesktopOnly");
    expect(() => parsePluginManifest(bytes(`${'{"x":'.repeat(17)}0${"}".repeat(17)}`))).toThrow("depth");
    expect(() => parsePluginManifest(new Uint8Array(256 * 1024 + 1))).toThrow("exceeds");
  });

  it("compares arbitrarily large decimal components without Number precision", () => {
    expect(comparePlainVersion("9007199254740993.0.0", "9007199254740992.999.999")).toBe(1);
    expect(isPortablePluginCompatible({ id: "p", version: "1.0.0", minAppVersion: "9007199254740993.0.0" }, "p", "9007199254740992.999.999")).toBe(false);
  });
});

function bytes(source: string): Uint8Array { return new TextEncoder().encode(source); }
