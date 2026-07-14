import { describe, expect, it } from "vitest";
import { encodeCommunityPluginIds, mergePortableEnabledPluginIds, observeCommunityPluginIds, parseCommunityPluginIds, portableEnabledPluginIds } from "../../core/community-plugins";
import { createDefaultConfigProfile } from "../../core/config-profile";

describe("structured community plugin enablement", () => {
  it("parses bounded unique IDs and excludes the sync plugin from remote representation", () => {
    expect(parseCommunityPluginIds(new TextEncoder().encode('["one","two"]'))).toEqual(["one", "two"]);
    const profile = { ...createDefaultConfigProfile("1.8.0"), portablePluginIds: ["one", "obsidian-s3-sync"] };
    expect(portableEnabledPluginIds(["one", "obsidian-s3-sync", "local"], profile, "obsidian-s3-sync")).toEqual(["one"]);
  });

  it("treats malformed, BOM, aliases, wrong roots, and over-limit lists as unknown-worthy errors", () => {
    for (const source of ['{"one":true}', '["one",]', '["one","ONE"]']) {
      expect(() => parseCommunityPluginIds(new TextEncoder().encode(source))).toThrow();
    }
    expect(() => parseCommunityPluginIds(new Uint8Array([0xef, 0xbb, 0xbf, 0x5b, 0x5d]))).toThrow("BOM");
    const overLimit = new TextEncoder().encode(`[${Array.from({ length: 100_001 }, (_, index) => `"p${index}"`).join(",")}]`);
    expect(() => parseCommunityPluginIds(overLimit)).toThrow("100,000");
    expect(observeCommunityPluginIds({ kind: "present", bytes: new TextEncoder().encode('["one",]') })).toMatchObject({ status: "unknown" });
    expect(observeCommunityPluginIds({ kind: "unknown", reason: "read-failed" })).toEqual({ status: "unknown", reason: "read-failed" });
    expect(observeCommunityPluginIds({ kind: "confirmed-absent" })).toEqual({ status: "complete", ids: [] });
  });

  it("replaces only the portable subset, preserves local IDs and the sync plugin, and blocks aliases", () => {
    expect(mergePortableEnabledPluginIds({ remotePortableEnabled: ["portable-b"], localEnabled: ["portable-a", "local"], portablePluginIds: ["portable-a", "portable-b"], syncPluginId: "obsidian-s3-sync" }))
      .toEqual(["local", "obsidian-s3-sync", "portable-b"]);
    expect(() => mergePortableEnabledPluginIds({ remotePortableEnabled: [], localEnabled: ["PORTABLE-A"], portablePluginIds: ["portable-a"], syncPluginId: "obsidian-s3-sync" })).toThrow("aliases");
    expect(() => mergePortableEnabledPluginIds({ remotePortableEnabled: [], localEnabled: Array.from({ length: 100_001 }, (_, index) => `local-${index}`), portablePluginIds: [], syncPluginId: "obsidian-s3-sync" })).toThrow("100,000");
    expect(parseCommunityPluginIds(encodeCommunityPluginIds(["two", "one"]))).toEqual(["one", "two"]);
  });
});
