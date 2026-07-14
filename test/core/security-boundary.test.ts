import { describe, expect, it } from "vitest";
import { v1SecurityBoundaryDisclosures } from "../../core/security-boundary";

describe("v1 security boundary disclosure", () => {
  it("keeps every release trust and confidentiality limitation explicit", () => {
    expect(v1SecurityBoundaryDisclosures.map((item) => item.id)).toEqual([
      "trusted-writers",
      "plaintext",
      "unsigned",
      "no-e2ee",
      "plugin-code",
    ]);
    const text = v1SecurityBoundaryDisclosures.map((item) => `${item.label} ${item.detail}`).join(" ");
    expect(text).toMatch(/可信.*写入/);
    expect(text).toMatch(/路径.*字节.*明文|对象 Key.*对象字节/);
    expect(text).toContain("签名");
    expect(text).toContain("E2EE");
    expect(text).toMatch(/插件.*执行/);
  });
});
