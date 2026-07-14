import { describe, expect, it } from "vitest";
import { isPortablePluginCompatible } from "../../core/plugin-compatibility";

describe("portable plugin compatibility", () => {
  it("requires matching IDs, compatible target version and desktop support", () => {
    expect(isPortablePluginCompatible({ id: "plugin", version: "1.0.0", minAppVersion: "1.5.0" }, "plugin", "1.6.0")).toBe(true);
    expect(isPortablePluginCompatible({ id: "plugin", version: "1.0.0", minAppVersion: "1.0.0", isDesktopOnly: true }, "plugin", "1.6.0")).toBe(false);
    expect(isPortablePluginCompatible({ id: "plugin", version: "1.0.0" }, "plugin", "1.6.0")).toBe(false);
    expect(isPortablePluginCompatible({ id: "other", version: "1.0.0", minAppVersion: "1.0.0" }, "plugin", "1.6.0")).toBe(false);
  });
});
